import * as fs from "node:fs/promises";
import * as path from "node:path";
import { archiveEntryText, readArchiveEntries } from "../ar";
import { attribute, childElements, descendants, firstChild, localName, parseXml, type XmlElement } from "./xml";

/** A mammoth-compatible diagnostic emitted while converting a document. */
export interface DocxMessage {
	readonly type: "warning" | "error";
	readonly message: string;
}

/** The HTML and diagnostics produced by a DOCX conversion. */
export interface DocxResult {
	readonly value: string;
	readonly messages: DocxMessage[];
}

/** An in-memory or filesystem DOCX input. */
export type DocxInput =
	| { readonly buffer: Uint8Array; readonly path?: never }
	| { readonly path: string; readonly buffer?: never };

/** An image exposed to a custom image converter. */
export interface DocxImage {
	readonly contentType: string;
	readonly altText: string;
	/** Read the image payload using mammoth's used encoding surface. */
	read(encoding: "base64"): Promise<string>;
}

/** HTML attributes returned by a custom image converter. */
export type ImageAttributes = Readonly<Record<string, string>>;

/** A callback that maps an embedded DOCX image to HTML attributes. */
export type ImageAttributeConverter = (image: DocxImage) => ImageAttributes | Promise<ImageAttributes>;

/** An image converter created by `images.imgElement`. */
export interface ImageConverter {
	readonly convert: ImageAttributeConverter;
}

/** Options supported by the behavior-compatible DOCX converter. */
export interface ConvertToHtmlOptions {
	readonly convertImage?: ImageConverter;
	readonly styleMap?: string | readonly string[];
	readonly includeDefaultStyleMap?: boolean;
}

/** Mammoth-shaped helpers for configuring embedded image conversion. */
export const images = {
	/** Wrap an image-to-attributes callback for `convertToHtml`. */
	imgElement(convert: ImageAttributeConverter): ImageConverter {
		return { convert };
	},
};

interface Relationship {
	readonly target: string;
	readonly type: string;
	readonly external: boolean;
}

interface Formatting {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly strike?: boolean;
	readonly vertical?: "subscript" | "superscript";
}

interface NumberingReference {
	readonly id: string;
	readonly level: number;
}

interface Style {
	readonly id: string;
	readonly type: "paragraph" | "character";
	readonly name: string;
	readonly basedOn?: string;
	readonly formatting: Formatting;
	readonly numbering?: NumberingReference;
	readonly isDefault: boolean;
}

interface CustomStyle {
	readonly kind: "paragraph" | "character";
	readonly styleName: string;
	readonly tag: string;
}

interface ParagraphBlock {
	readonly kind: "paragraph";
	readonly html: string;
	readonly tag: string;
	readonly list?: { readonly level: number; readonly ordered: boolean };
}

interface RawTableCell {
	readonly html: string;
	readonly columnSpan: number;
	readonly merge: "restart" | "continue" | undefined;
}

interface TableCell {
	readonly html: string;
	readonly columnSpan: number;
	rowSpan: number;
}

interface HtmlBlock {
	readonly kind: "html";
	readonly html: string;
}

type Block = ParagraphBlock | HtmlBlock;

interface NumberingLevel {
	readonly ordered: boolean;
}

interface ConversionContext {
	readonly entries: ReadonlyMap<string, Uint8Array>;
	readonly relationships: ReadonlyMap<string, Relationship>;
	readonly contentTypes: ReadonlyMap<string, string>;
	readonly styles: ReadonlyMap<string, Style>;
	readonly numbering: ReadonlyMap<string, ReadonlyMap<number, NumberingLevel>>;
	readonly messages: DocxMessage[];
	readonly warnedStyles: Set<string>;
	readonly customStyles: readonly CustomStyle[];
	readonly includeDefaultStyleMap: boolean;
	readonly convertImage: ImageConverter;
	readonly footnotes: ReadonlyMap<string, XmlElement>;
	readonly usedFootnotes: Array<{ readonly id: string; readonly ordinal: number }>;
	readonly footnoteOrdinals: Map<string, number>;
}

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
	bmp: "image/bmp",
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	webp: "image/webp",
};

function escapeText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replaceAll('"', "&quot;");
}

function enabled(property: XmlElement | undefined): boolean | undefined {
	if (!property) return undefined;
	const value = attribute(property, "w:val")?.toLowerCase();
	return value !== "0" && value !== "false" && value !== "off" && value !== "none";
}

function formattingFromProperties(properties: XmlElement | undefined): Formatting {
	if (!properties) return {};
	const vertical = attribute(firstChild(properties, "vertAlign"), "w:val");
	return {
		bold: enabled(firstChild(properties, "b")),
		italic: enabled(firstChild(properties, "i")),
		strike: enabled(firstChild(properties, "strike")) ?? enabled(firstChild(properties, "dstrike")),
		vertical: vertical === "subscript" || vertical === "superscript" ? vertical : undefined,
	};
}

function mergeFormatting(base: Formatting, override: Formatting): Formatting {
	return {
		bold: override.bold ?? base.bold,
		italic: override.italic ?? base.italic,
		strike: override.strike ?? base.strike,
		vertical: override.vertical ?? base.vertical,
	};
}

function parseNumberingReference(properties: XmlElement | undefined): NumberingReference | undefined {
	const numberProperties = firstChild(properties, "numPr");
	const id = attribute(firstChild(numberProperties, "numId"), "w:val");
	if (!id || id === "0") return undefined;
	const rawLevel = attribute(firstChild(numberProperties, "ilvl"), "w:val");
	return { id, level: rawLevel ? Number.parseInt(rawLevel, 10) || 0 : 0 };
}

function parseStyles(xml: string | undefined): Map<string, Style> {
	const styles = new Map<string, Style>();
	if (!xml) return styles;
	const root = parseXml(xml);
	for (const element of childElements(root, "style")) {
		const id = attribute(element, "w:styleId");
		const rawType = attribute(element, "w:type");
		if (!id || (rawType !== "paragraph" && rawType !== "character")) continue;
		styles.set(id, {
			id,
			type: rawType,
			name: attribute(firstChild(element, "name"), "w:val") ?? id,
			basedOn: attribute(firstChild(element, "basedOn"), "w:val"),
			formatting: formattingFromProperties(firstChild(element, "rPr")),
			numbering: parseNumberingReference(firstChild(element, "pPr")),
			isDefault: attribute(element, "w:default") === "1" || attribute(element, "w:default") === "true",
		});
	}
	return styles;
}

function resolveStyleFormatting(
	style: Style | undefined,
	styles: ReadonlyMap<string, Style>,
	visited = new Set<string>(),
): Formatting {
	if (!style || visited.has(style.id)) return {};
	visited.add(style.id);
	const base = style.basedOn ? resolveStyleFormatting(styles.get(style.basedOn), styles, visited) : {};
	return mergeFormatting(base, style.formatting);
}

function resolveStyleNumbering(
	style: Style | undefined,
	styles: ReadonlyMap<string, Style>,
	visited = new Set<string>(),
): NumberingReference | undefined {
	if (!style || visited.has(style.id)) return undefined;
	visited.add(style.id);
	return (
		style.numbering ?? (style.basedOn ? resolveStyleNumbering(styles.get(style.basedOn), styles, visited) : undefined)
	);
}

function parseRelationships(xml: string | undefined): Map<string, Relationship> {
	const relationships = new Map<string, Relationship>();
	if (!xml) return relationships;
	const root = parseXml(xml);
	for (const element of childElements(root, "Relationship")) {
		const id = attribute(element, "Id");
		const target = attribute(element, "Target");
		if (!id || !target) continue;
		relationships.set(id, {
			target,
			type: attribute(element, "Type") ?? "",
			external: attribute(element, "TargetMode") === "External",
		});
	}
	return relationships;
}

function parseContentTypes(xml: string | undefined): Map<string, string> {
	const types = new Map<string, string>();
	if (!xml) return types;
	const root = parseXml(xml);
	for (const element of childElements(root)) {
		if (localName(element.name) === "Default") {
			const extension = attribute(element, "Extension")?.toLowerCase();
			const contentType = attribute(element, "ContentType");
			if (extension && contentType) types.set(`.${extension}`, contentType);
		} else if (localName(element.name) === "Override") {
			const part = attribute(element, "PartName");
			const contentType = attribute(element, "ContentType");
			if (part && contentType) types.set(part.startsWith("/") ? part.slice(1) : part, contentType);
		}
	}
	return types;
}

function parseNumbering(xml: string | undefined): Map<string, ReadonlyMap<number, NumberingLevel>> {
	const result = new Map<string, ReadonlyMap<number, NumberingLevel>>();
	if (!xml) return result;
	const root = parseXml(xml);
	const abstractLevels = new Map<string, Map<number, NumberingLevel>>();
	for (const abstract of childElements(root, "abstractNum")) {
		const id = attribute(abstract, "w:abstractNumId");
		if (!id) continue;
		const levels = new Map<number, NumberingLevel>();
		for (const level of childElements(abstract, "lvl")) {
			const index = Number.parseInt(attribute(level, "w:ilvl") ?? "0", 10) || 0;
			levels.set(index, { ordered: attribute(firstChild(level, "numFmt"), "w:val") !== "bullet" });
		}
		abstractLevels.set(id, levels);
	}
	for (const number of childElements(root, "num")) {
		const id = attribute(number, "w:numId");
		const abstractId = attribute(firstChild(number, "abstractNumId"), "w:val");
		if (id && abstractId) result.set(id, abstractLevels.get(abstractId) ?? new Map());
	}
	return result;
}

function parseFootnotes(xml: string | undefined): Map<string, XmlElement> {
	const notes = new Map<string, XmlElement>();
	if (!xml) return notes;
	for (const element of childElements(parseXml(xml), "footnote")) {
		const id = attribute(element, "w:id");
		if (id && !id.startsWith("-")) notes.set(id, element);
	}
	return notes;
}

function parseCustomStyles(styleMap: string | readonly string[] | undefined): CustomStyle[] {
	const lines = typeof styleMap === "string" ? styleMap.split("\n") : (styleMap ?? []);
	const mappings: CustomStyle[] = [];
	for (const line of lines) {
		const match = /^\s*(p|r)\s*\[style-name\s*=\s*['"]([^'"]+)['"]\]\s*=>\s*([\w-]+)/i.exec(line);
		if (!match) continue;
		mappings.push({
			kind: match[1].toLowerCase() === "p" ? "paragraph" : "character",
			styleName: match[2],
			tag: match[3],
		});
	}
	return mappings;
}

function styleMapping(
	context: ConversionContext,
	style: Style | undefined,
	kind: "paragraph" | "character",
): CustomStyle | undefined {
	if (!style) return undefined;
	return context.customStyles.find(mapping => mapping.kind === kind && mapping.styleName === style.name);
}

function warnUnrecognisedStyle(
	context: ConversionContext,
	styleId: string,
	style: Style | undefined,
	kind: "paragraph" | "run",
): void {
	const key = `${kind}:${styleId}`;
	if (context.warnedStyles.has(key)) return;
	context.warnedStyles.add(key);
	const name = style?.name ?? styleId;
	context.messages.push({ type: "warning", message: `Unrecognised ${kind} style: '${name}' (Style ID: ${styleId})` });
}

function paragraphTag(context: ConversionContext, styleId: string | undefined): string {
	if (!styleId) return "p";
	const style = context.styles.get(styleId);
	const custom = styleMapping(context, style, "paragraph");
	if (custom) return custom.tag;
	const heading = context.includeDefaultStyleMap
		? /^(?:heading\s*|heading)([1-6])$/i.exec(style?.name ?? styleId)
		: null;
	if (heading) return `h${heading[1]}`;
	if (!style?.isDefault && (style?.name.toLowerCase() ?? styleId.toLowerCase()) !== "normal") {
		warnUnrecognisedStyle(context, styleId, style, "paragraph");
	}
	return "p";
}

function relationshipPath(target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	return path.posix.normalize(path.posix.join("word", target));
}

function renderFormatting(value: string, formatting: Formatting): string {
	let html = value;
	if (formatting.strike) html = `<s>${html}</s>`;
	if (formatting.vertical === "subscript") html = `<sub>${html}</sub>`;
	if (formatting.vertical === "superscript") html = `<sup>${html}</sup>`;
	if (formatting.italic) html = `<em>${html}</em>`;
	if (formatting.bold) html = `<strong>${html}</strong>`;
	return html;
}

async function renderImage(element: XmlElement, context: ConversionContext): Promise<string> {
	const blip = descendants(element, "blip")[0];
	const relationshipId = attribute(blip, "r:embed");
	const relationship = relationshipId ? context.relationships.get(relationshipId) : undefined;
	if (!relationship || relationship.external) return "";
	const memberPath = relationshipPath(relationship.target);
	const bytes = context.entries.get(memberPath);
	if (!bytes) {
		context.messages.push({ type: "warning", message: `Could not find image ${memberPath}` });
		return "";
	}
	const documentProperties = descendants(element, "docPr")[0];
	const altText = attribute(documentProperties, "descr") ?? attribute(documentProperties, "title") ?? "";
	const extension = path.posix.extname(memberPath).toLowerCase();
	const contentType =
		context.contentTypes.get(memberPath) ??
		context.contentTypes.get(extension) ??
		IMAGE_CONTENT_TYPE_BY_EXTENSION[extension.slice(1)] ??
		"application/octet-stream";
	const image: DocxImage = {
		contentType,
		altText,
		async read(encoding: "base64"): Promise<string> {
			if (encoding !== "base64") throw new Error(`Unsupported image encoding: ${encoding}`);
			return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
		},
	};
	const converted = await context.convertImage.convert(image);
	const attributes = Object.entries(converted)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
		.join(" ");
	return attributes ? `<img ${attributes} />` : "<img />";
}

function renderFootnoteReference(element: XmlElement, context: ConversionContext): string {
	const id = attribute(element, "w:id");
	if (!id || !context.footnotes.has(id)) return "";
	let ordinal = context.footnoteOrdinals.get(id);
	if (ordinal === undefined) {
		ordinal = context.usedFootnotes.length + 1;
		context.footnoteOrdinals.set(id, ordinal);
		context.usedFootnotes.push({ id, ordinal });
	}
	return `<sup><a href="#footnote-${escapeAttribute(id)}" id="footnote-ref-${escapeAttribute(id)}">[${ordinal}]</a></sup>`;
}

async function renderInlineChildren(element: XmlElement, context: ConversionContext): Promise<string> {
	let html = "";
	for (const child of element.children) {
		if (child.kind === "text") continue;
		const name = localName(child.name);
		if (name === "r") {
			html += await renderRun(child, context);
		} else if (name === "hyperlink") {
			const contents = await renderInlineChildren(child, context);
			const relationshipId = attribute(child, "r:id");
			const anchor = attribute(child, "w:anchor");
			const target = relationshipId
				? context.relationships.get(relationshipId)?.target
				: anchor
					? `#${anchor}`
					: undefined;
			html += target ? `<a href="${escapeAttribute(target)}">${contents}</a>` : contents;
		} else if (name !== "del") {
			html += await renderInlineChildren(child, context);
		}
	}
	return html;
}

async function renderRun(run: XmlElement, context: ConversionContext): Promise<string> {
	const properties = firstChild(run, "rPr");
	const styleId = attribute(firstChild(properties, "rStyle"), "w:val");
	const style = styleId ? context.styles.get(styleId) : undefined;
	const custom = styleMapping(context, style, "character");
	let formatting = mergeFormatting(
		resolveStyleFormatting(style, context.styles),
		formattingFromProperties(properties),
	);
	if (styleId && !custom) {
		if (context.includeDefaultStyleMap && (style?.name ?? styleId).toLowerCase() === "strong") {
			formatting = { ...formatting, bold: true };
		} else {
			warnUnrecognisedStyle(context, styleId, style, "run");
		}
	}
	let value = "";
	for (const child of childElements(run)) {
		const name = localName(child.name);
		if (name === "t" || name === "instrText") {
			for (const node of child.children) if (node.kind === "text") value += escapeText(node.value);
		} else if (name === "tab") {
			value += "\t";
		} else if (name === "br") {
			if (attribute(child, "w:type") !== "page") value += "<br />";
		} else if (name === "noBreakHyphen") {
			value += "‑";
		} else if (name === "softHyphen") {
			value += "­";
		} else if (name === "drawing" || name === "pict") {
			value += await renderImage(child, context);
		} else if (name === "footnoteReference") {
			value += renderFootnoteReference(child, context);
		}
	}
	let html = renderFormatting(value, formatting);
	if (custom) html = `<${custom.tag}>${html}</${custom.tag}>`;
	return html;
}

async function parseParagraph(element: XmlElement, context: ConversionContext): Promise<ParagraphBlock | undefined> {
	const properties = firstChild(element, "pPr");
	const styleId = attribute(firstChild(properties, "pStyle"), "w:val");
	const style = styleId ? context.styles.get(styleId) : undefined;
	const tag = paragraphTag(context, styleId);
	const directNumbering = parseNumberingReference(properties);
	const numberingReference = directNumbering ?? resolveStyleNumbering(style, context.styles);
	const html = await renderInlineChildren(element, context);
	if (!html && !numberingReference) return undefined;
	const numberingLevel = numberingReference
		? context.numbering.get(numberingReference.id)?.get(numberingReference.level)
		: undefined;
	return {
		kind: "paragraph",
		html,
		tag,
		list: numberingReference
			? { level: numberingReference.level, ordered: numberingLevel?.ordered ?? true }
			: undefined,
	};
}

function renderList(
	items: readonly ParagraphBlock[],
	start: number,
	level: number,
): { readonly html: string; readonly next: number } {
	const ordered = items[start].list?.ordered ?? true;
	const tag = ordered ? "ol" : "ul";
	let html = `<${tag}>`;
	let index = start;
	while (index < items.length) {
		const item = items[index];
		const list = item.list;
		if (!list || list.level < level || (list.level === level && list.ordered !== ordered)) break;
		if (list.level > level) break;
		html += `<li>${item.html}`;
		index++;
		while (index < items.length && (items[index].list?.level ?? -1) > level) {
			const nested = renderList(items, index, items[index].list?.level ?? level + 1);
			html += nested.html;
			index = nested.next;
		}
		html += "</li>";
	}
	html += `</${tag}>`;
	return { html, next: index };
}

function renderBlocks(blocks: readonly Block[]): string {
	let html = "";
	for (let index = 0; index < blocks.length; ) {
		const block = blocks[index];
		if (block.kind === "html") {
			html += block.html;
			index++;
			continue;
		}
		if (!block.list) {
			html += `<${block.tag}>${block.html}</${block.tag}>`;
			index++;
			continue;
		}
		const listItems: ParagraphBlock[] = [];
		while (index < blocks.length) {
			const candidate = blocks[index];
			if (candidate.kind !== "paragraph" || !candidate.list) break;
			listItems.push(candidate);
			index++;
		}
		for (let itemIndex = 0; itemIndex < listItems.length; ) {
			const rendered = renderList(listItems, itemIndex, listItems[itemIndex].list?.level ?? 0);
			html += rendered.html;
			itemIndex = rendered.next;
		}
	}
	return html;
}

async function parseTableCell(element: XmlElement, context: ConversionContext): Promise<RawTableCell> {
	const properties = firstChild(element, "tcPr");
	const span = Number.parseInt(attribute(firstChild(properties, "gridSpan"), "w:val") ?? "1", 10) || 1;
	const verticalMerge = firstChild(properties, "vMerge");
	const mergeValue = attribute(verticalMerge, "w:val");
	const merge = verticalMerge ? (mergeValue === "restart" ? "restart" : "continue") : undefined;
	const blocks = await parseBlocks(childElements(element), context);
	return { html: renderBlocks(blocks), columnSpan: span, merge };
}

async function renderTable(element: XmlElement, context: ConversionContext): Promise<string> {
	const rows: TableCell[][] = [];
	let active = new Map<number, TableCell>();
	for (const rowElement of childElements(element, "tr")) {
		const row: TableCell[] = [];
		const nextActive = new Map<number, TableCell>();
		let column = 0;
		const extended = new Set<TableCell>();
		for (const cellElement of childElements(rowElement, "tc")) {
			const raw = await parseTableCell(cellElement, context);
			if (raw.merge === "continue") {
				const origin = active.get(column);
				if (origin) {
					if (!extended.has(origin)) {
						origin.rowSpan++;
						extended.add(origin);
					}
					for (let offset = 0; offset < raw.columnSpan; offset++) nextActive.set(column + offset, origin);
					column += raw.columnSpan;
					continue;
				}
			}
			const cell: TableCell = { html: raw.html, columnSpan: raw.columnSpan, rowSpan: 1 };
			row.push(cell);
			if (raw.merge === "restart") {
				for (let offset = 0; offset < raw.columnSpan; offset++) nextActive.set(column + offset, cell);
			}
			column += raw.columnSpan;
		}
		rows.push(row);
		active = nextActive;
	}
	let html = "<table>";
	for (const row of rows) {
		html += "<tr>";
		for (const cell of row) {
			const columnSpan = cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : "";
			const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : "";
			html += `<td${columnSpan}${rowSpan}>${cell.html}</td>`;
		}
		html += "</tr>";
	}
	return `${html}</table>`;
}

async function parseBlocks(elements: readonly XmlElement[], context: ConversionContext): Promise<Block[]> {
	const blocks: Block[] = [];
	for (const element of elements) {
		const name = localName(element.name);
		if (name === "p") {
			const paragraph = await parseParagraph(element, context);
			if (paragraph) blocks.push(paragraph);
		} else if (name === "tbl") {
			blocks.push({ kind: "html", html: await renderTable(element, context) });
		} else if (name === "sdt" || name === "customXml") {
			blocks.push(...(await parseBlocks(childElements(element), context)));
		}
	}
	return blocks;
}

async function renderFootnotes(context: ConversionContext): Promise<string> {
	if (context.usedFootnotes.length === 0) return "";
	let html = "<ol>";
	for (const note of context.usedFootnotes) {
		const element = context.footnotes.get(note.id);
		if (!element) continue;
		let contents = renderBlocks(await parseBlocks(childElements(element), context));
		const backlink = `<a href="#footnote-ref-${escapeAttribute(note.id)}">↑</a>`;
		const lastParagraph = contents.lastIndexOf("</p>");
		if (lastParagraph === -1) contents += backlink;
		else contents = `${contents.slice(0, lastParagraph)} ${backlink}${contents.slice(lastParagraph)}`;
		html += `<li id="footnote-${escapeAttribute(note.id)}">${contents}</li>`;
	}
	return `${html}</ol>`;
}

function defaultImageConverter(): ImageConverter {
	return images.imgElement(async image => ({
		alt: image.altText,
		src: `data:${image.contentType};base64,${await image.read("base64")}`,
	}));
}

/** Convert a DOCX buffer or path to mammoth-compatible HTML. */
export async function convertToHtml(input: DocxInput, options: ConvertToHtmlOptions = {}): Promise<DocxResult> {
	const bytes = "buffer" in input && input.buffer ? input.buffer : await fs.readFile(input.path);
	const entries = await readArchiveEntries({ bytes, format: "zip" });
	const documentXml = archiveEntryText(entries, "word/document.xml");
	if (!documentXml) throw new Error("Invalid DOCX: missing word/document.xml");
	const context: ConversionContext = {
		entries,
		relationships: parseRelationships(archiveEntryText(entries, "word/_rels/document.xml.rels")),
		contentTypes: parseContentTypes(archiveEntryText(entries, "[Content_Types].xml")),
		styles: parseStyles(archiveEntryText(entries, "word/styles.xml")),
		numbering: parseNumbering(archiveEntryText(entries, "word/numbering.xml")),
		messages: [],
		warnedStyles: new Set(),
		customStyles: parseCustomStyles(options.styleMap),
		includeDefaultStyleMap: options.includeDefaultStyleMap !== false,
		convertImage: options.convertImage ?? defaultImageConverter(),
		footnotes: parseFootnotes(archiveEntryText(entries, "word/footnotes.xml")),
		usedFootnotes: [],
		footnoteOrdinals: new Map(),
	};
	const document = parseXml(documentXml);
	const body = firstChild(document, "body");
	if (!body) throw new Error("Invalid DOCX: missing document body");
	const value = renderBlocks(await parseBlocks(childElements(body), context)) + (await renderFootnotes(context));
	return { value, messages: context.messages };
}
