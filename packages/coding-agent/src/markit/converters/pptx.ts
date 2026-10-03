// Adapted from markit-ai (MIT). See ../NOTICE.
import * as path from "node:path";
import { archiveEntryText, readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { XMLParser } from "@oh-my-pi/pi-utils/xml";
import type { ConversionResult, Converter, StreamInfo } from "../types";

const EXTENSIONS = [".pptx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.presentationml.presentation"];

/** A text value: bare string/number, or a `{ "#text" }` node when the element carries attributes. */
type XmlText = string | number | { "#text"?: string };

interface TextRun {
	"a:t"?: XmlText;
}
interface Paragraph {
	"a:r"?: TextRun | TextRun[];
}
interface TextBody {
	"a:p"?: Paragraph | Paragraph[];
}
interface CNvPr {
	"@_name": string;
}
interface Placeholder {
	"@_type": string;
}
interface NvPr {
	"p:ph"?: Placeholder;
}
interface NvSpPr {
	"p:cNvPr"?: CNvPr;
	"p:nvPr"?: NvPr;
}
interface NvPicPr {
	"p:cNvPr"?: CNvPr;
}
interface Shape {
	"p:txBody"?: TextBody;
	"p:nvSpPr"?: NvSpPr;
}
interface Blip {
	"@_r:embed": string;
}
interface BlipFill {
	"a:blip"?: Blip;
}
interface Picture {
	"p:blipFill"?: BlipFill;
	"p:nvSpPr"?: NvSpPr;
	"p:nvPicPr"?: NvPicPr;
}
interface TableCell {
	"a:txBody"?: TextBody;
}
interface TableRow {
	"a:tc"?: TableCell | TableCell[];
}
interface Table {
	"a:tr"?: TableRow | TableRow[];
}
interface GraphicData {
	"a:tbl"?: Table;
}
interface Graphic {
	"a:graphicData"?: GraphicData;
}
interface GraphicFrame {
	"a:graphic"?: Graphic;
}
interface SpTree {
	"p:sp"?: Shape | Shape[];
	"p:pic"?: Picture | Picture[];
	"p:graphicFrame"?: GraphicFrame | GraphicFrame[];
}
interface CSld {
	"p:spTree"?: SpTree;
}
interface SlideDoc {
	"p:sld"?: { "p:cSld"?: CSld };
}
interface NotesDoc {
	"p:notes"?: { "p:cSld"?: CSld };
}
interface SldId {
	"@_r:id": string;
}
interface PresentationDoc {
	"p:presentation"?: { "p:sldIdLst"?: { "p:sldId"?: SldId | SldId[] } };
}
interface Relationship {
	"@_Id": string;
	"@_Target": string;
}
interface RelationshipsDoc {
	Relationships?: { Relationship?: Relationship | Relationship[] };
}

export class PptxConverter implements Converter {
	name = "pptx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = await readArchiveEntries({ bytes: input, format: "zip" });
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		// Get slide order from presentation.xml
		const presXml = archiveEntryText(entries, "ppt/presentation.xml");
		if (!presXml) throw new Error("Invalid PPTX: missing presentation.xml");
		const pres = parser.parse(presXml) as PresentationDoc;
		const sldIdList = pres["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"];
		const sldIds = Array.isArray(sldIdList) ? sldIdList : sldIdList ? [sldIdList] : [];
		// Get relationship mappings
		const relsXml = archiveEntryText(entries, "ppt/_rels/presentation.xml.rels");
		const rels = relsXml ? (parser.parse(relsXml) as RelationshipsDoc) : null;
		const relList = rels?.Relationships?.Relationship;
		const relArray = Array.isArray(relList) ? relList : relList ? [relList] : [];
		const relMap = new Map<string, string>();
		for (const r of relArray) {
			relMap.set(r["@_Id"], r["@_Target"]);
		}
		// Map slide IDs to file paths in order
		const slidePaths: string[] = [];
		for (const sld of sldIds) {
			const rId = sld["@_r:id"];
			const target = relMap.get(rId);
			if (target) slidePaths.push(`ppt/${target}`);
		}
		// If we couldn't resolve from rels, fall back to finding slide files
		if (slidePaths.length === 0) {
			const slideFiles = Object.keys(entries)
				.filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
				.sort((a, b) => {
					const na = parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
					const nb = parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
					return na - nb;
				});
			slidePaths.push(...slideFiles);
		}
		const imageDir = streamInfo.imageDir;
		const sections: string[] = [];
		let imageCount = 0;
		for (let i = 0; i < slidePaths.length; i++) {
			const slideXml = archiveEntryText(entries, slidePaths[i]);
			if (!slideXml) continue;
			const slide = parser.parse(slideXml) as SlideDoc;
			const spTree = slide["p:sld"]?.["p:cSld"]?.["p:spTree"];
			if (!spTree) continue;
			// Parse slide-level rels for image references
			const slideRelsPath = `${slidePaths[i].replace("slides/slide", "slides/_rels/slide")}.rels`;
			const slideRelsXml = archiveEntryText(entries, slideRelsPath);
			const slideRelMap = new Map<string, string>();
			if (slideRelsXml) {
				const slideRels = parser.parse(slideRelsXml) as RelationshipsDoc;
				const relItems = toList(slideRels?.Relationships?.Relationship);
				for (const r of relItems) {
					slideRelMap.set(r["@_Id"], r["@_Target"]);
				}
			}
			const slideLines = [`<!-- Slide ${i + 1} -->`];
			const shapes = spTree["p:sp"];
			const shapeList = Array.isArray(shapes) ? shapes : shapes ? [shapes] : [];
			let isTitle = true;
			for (const shape of shapeList) {
				const text = this.extractText(shape);
				if (!text) continue;
				if (isTitle) {
					slideLines.push(`# ${text}`);
					isTitle = false;
				} else {
					slideLines.push(text);
				}
			}
			// Extract embedded images
			const pics = toList(spTree["p:pic"]);
			for (const pic of pics) {
				const blipFill = pic["p:blipFill"];
				const rEmbed = blipFill?.["a:blip"]?.["@_r:embed"];
				if (!rEmbed) continue;
				const target = slideRelMap.get(rEmbed);
				if (!target) continue;
				// Resolve relative target against slide directory
				const imagePath = target.startsWith("/") ? target.slice(1) : `ppt/slides/${target}`;
				// Normalize path (e.g. ppt/slides/../media/image1.png → ppt/media/image1.png)
				const normalizedPath = imagePath
					.split("/")
					.reduce<string[]>((parts, seg) => {
						if (seg === "..") parts.pop();
						else parts.push(seg);
						return parts;
					}, [])
					.join("/");
				const buf = entries.get(normalizedPath);
				if (!buf) continue;
				imageCount++;
				const name =
					pic["p:nvSpPr"]?.["p:cNvPr"]?.["@_name"] ||
					pic["p:nvPicPr"]?.["p:cNvPr"]?.["@_name"] ||
					`image_${imageCount}`;
				if (imageDir) {
					try {
						const ext = normalizedPath.split(".").pop() || "png";
						const filename = `slide${i + 1}_${imageCount}.${ext}`;
						const filepath = path.join(imageDir, filename);
						await Bun.write(filepath, buf);
						slideLines.push(`![${name}](${filepath})`);
					} catch {
						slideLines.push(`<!-- image: ${name} (slide ${i + 1}) -->`);
					}
				} else {
					slideLines.push(`<!-- image: ${name} (slide ${i + 1}) -->`);
				}
			}
			// Tables
			const graphicFrames = spTree["p:graphicFrame"];
			const gfList = Array.isArray(graphicFrames) ? graphicFrames : graphicFrames ? [graphicFrames] : [];
			for (const gf of gfList) {
				const table = this.extractTable(gf);
				if (table) slideLines.push(table);
			}
			// Slide notes
			const noteFile = slidePaths[i].replace("slides/slide", "notesSlides/notesSlide");
			const noteXml = archiveEntryText(entries, noteFile);
			if (noteXml) {
				const note = parser.parse(noteXml) as NotesDoc;
				const noteSpTree = note["p:notes"]?.["p:cSld"]?.["p:spTree"];
				if (noteSpTree) {
					const noteShapes = noteSpTree["p:sp"];
					const noteList = Array.isArray(noteShapes) ? noteShapes : noteShapes ? [noteShapes] : [];
					const noteTexts: string[] = [];
					for (const ns of noteList) {
						// Skip slide image placeholder
						const phType = ns["p:nvSpPr"]?.["p:nvPr"]?.["p:ph"]?.["@_type"];
						if (phType === "sldImg") continue;
						const t = this.extractText(ns);
						if (t) noteTexts.push(t);
					}
					if (noteTexts.length > 0) {
						slideLines.push("\n### Notes:");
						slideLines.push(noteTexts.join("\n"));
					}
				}
			}
			sections.push(slideLines.join("\n"));
		}
		return { markdown: sections.join("\n\n").trim() };
	}

	extractText(shape: Shape): string {
		const txBody = shape["p:txBody"];
		if (!txBody) return "";
		const paragraphs = txBody["a:p"];
		const pList = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
		const lines: string[] = [];
		for (const p of pList) {
			const runs = p["a:r"];
			const rList = Array.isArray(runs) ? runs : runs ? [runs] : [];
			const parts: string[] = [];
			for (const r of rList) {
				const t = r["a:t"];
				if (t != null) parts.push(typeof t === "object" ? t["#text"] || "" : String(t));
			}
			if (parts.length > 0) lines.push(parts.join(""));
		}
		return lines.join("\n").trim();
	}

	extractTable(gf: GraphicFrame): string | null {
		const tbl = gf?.["a:graphic"]?.["a:graphicData"]?.["a:tbl"];
		if (!tbl) return null;
		const rows = tbl["a:tr"];
		const rowList = Array.isArray(rows) ? rows : rows ? [rows] : [];
		if (rowList.length === 0) return null;
		const mdRows: string[][] = [];
		for (const row of rowList) {
			const cells = row["a:tc"];
			const cellList = Array.isArray(cells) ? cells : cells ? [cells] : [];
			const cellTexts: string[] = [];
			for (const cell of cellList) {
				const txBody = cell["a:txBody"];
				if (!txBody) {
					cellTexts.push("");
					continue;
				}
				const paragraphs = txBody["a:p"];
				const pList = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
				const parts: string[] = [];
				for (const p of pList) {
					const runs = p["a:r"];
					const rList = Array.isArray(runs) ? runs : runs ? [runs] : [];
					for (const r of rList) {
						const t = r["a:t"];
						if (t != null) parts.push(typeof t === "object" ? t["#text"] || "" : String(t));
					}
				}
				cellTexts.push(parts.join(" "));
			}
			mdRows.push(cellTexts);
		}
		if (mdRows.length === 0) return null;
		const [header, ...body] = mdRows;
		const lines: string[] = [];
		lines.push(`| ${header.join(" | ")} |`);
		lines.push(`| ${header.map(() => "---").join(" | ")} |`);
		for (const row of body) {
			while (row.length < header.length) row.push("");
			lines.push(`| ${row.join(" | ")} |`);
		}
		return lines.join("\n");
	}
}

function toList<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}
