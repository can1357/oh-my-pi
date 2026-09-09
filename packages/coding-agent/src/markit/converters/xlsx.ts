// Adapted from markit-ai (MIT). See ../NOTICE.

import { archiveEntryText, readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { XMLParser } from "@oh-my-pi/pi-utils/xml";
import type { ConversionResult, Converter, StreamInfo } from "../types";

const EXTENSIONS = [".xlsx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

/** A text value: bare string/number, or a `{ "#text" }` node when the element carries attributes. */
type XmlText = string | number | { "#text"?: string };

interface RichTextRun {
	t?: XmlText;
}
interface StringItem {
	t?: XmlText;
	r?: RichTextRun | RichTextRun[];
}
interface Cell {
	"@_t"?: string;
	v?: string | number;
	is?: StringItem;
}
interface Row {
	c?: Cell | Cell[];
}
interface WorksheetDoc {
	worksheet?: { sheetData?: { row?: Row | Row[] } };
}
interface Sheet {
	"@_name": string;
	"@_r:id": string;
}
interface WorkbookDoc {
	workbook?: { sheets?: { sheet?: Sheet | Sheet[] } };
}
interface SharedStringsDoc {
	sst?: { si?: StringItem | StringItem[] };
}
interface Relationship {
	"@_Id": string;
	"@_Target": string;
}
interface RelationshipsDoc {
	Relationships?: { Relationship?: Relationship | Relationship[] };
}

export class XlsxConverter implements Converter {
	name = "xlsx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = await readArchiveEntries({ bytes: input, format: "zip" });
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		// Parse shared strings
		const ssXml = archiveEntryText(entries, "xl/sharedStrings.xml");
		const ss = ssXml ? (parser.parse(ssXml) as SharedStringsDoc) : null;
		const siList = ss?.sst?.si;
		const shared = toArray(siList);
		// Parse workbook for sheet names
		const wbXml = archiveEntryText(entries, "xl/workbook.xml");
		if (!wbXml) throw new Error("Invalid XLSX: missing workbook.xml");
		const wb = parser.parse(wbXml) as WorkbookDoc;
		const sheets = toArray(wb.workbook?.sheets?.sheet);
		// Parse workbook rels to map rIds to sheet files
		const relsXml = archiveEntryText(entries, "xl/_rels/workbook.xml.rels");
		const rels = relsXml ? (parser.parse(relsXml) as RelationshipsDoc) : null;
		const relList = toArray(rels?.Relationships?.Relationship);
		const relMap = new Map<string, string>();
		for (const r of relList) {
			relMap.set(r["@_Id"], r["@_Target"]);
		}
		const sections: string[] = [];
		for (const sheet of sheets) {
			const sheetName = sheet["@_name"];
			const rId = sheet["@_r:id"];
			const target = relMap.get(rId);
			if (!target) continue;
			const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
			const sheetXml = archiveEntryText(entries, sheetPath);
			if (!sheetXml) continue;
			const parsed = parser.parse(sheetXml) as WorksheetDoc;
			const rows = toArray(parsed.worksheet?.sheetData?.row);
			if (rows.length === 0) continue;
			// Extract all rows as string arrays
			const tableRows: string[][] = [];
			for (const row of rows) {
				const cells = toArray(row.c);
				const values: string[] = [];
				for (const cell of cells) {
					values.push(this.getCellValue(cell, shared));
				}
				tableRows.push(values);
			}
			if (tableRows.length === 0) continue;
			// Normalize column count
			const maxCols = Math.max(...tableRows.map(r => r.length));
			for (const row of tableRows) {
				while (row.length < maxCols) row.push("");
			}
			sections.push(`## ${sheetName}`);
			const [header, ...body] = tableRows;
			const lines: string[] = [];
			lines.push(`| ${header.join(" | ")} |`);
			lines.push(`| ${header.map(() => "---").join(" | ")} |`);
			for (const row of body) {
				lines.push(`| ${row.join(" | ")} |`);
			}
			sections.push(lines.join("\n"));
		}
		return { markdown: sections.join("\n\n") };
	}

	getCellValue(cell: Cell, shared: StringItem[]): string {
		// Shared string
		if (cell["@_t"] === "s") {
			return this.getSharedString(shared, Number(cell.v));
		}
		// Inline string
		if (cell["@_t"] === "inlineStr") {
			const is = cell.is;
			if (!is) return "";
			if (is.t != null) return textValue(is.t);
			if (is.r)
				return toArray(is.r)
					.map(r => textValue(r.t))
					.join("");
			return "";
		}
		// Boolean
		if (cell["@_t"] === "b") {
			return cell.v === 1 || cell.v === "1" ? "TRUE" : "FALSE";
		}
		// Number or formula result
		if (cell.v != null) return String(cell.v);
		return "";
	}

	getSharedString(shared: StringItem[], idx: number): string {
		const si = shared[idx];
		if (!si) return "";
		// Simple text
		if (si.t != null) return textValue(si.t);
		// Rich text runs
		if (si.r) {
			return toArray(si.r)
				.map(r => textValue(r.t))
				.join("");
		}
		return "";
	}
}

function textValue(t: XmlText | undefined): string {
	if (t == null) return "";
	if (typeof t === "object") return t["#text"] || "";
	return String(t);
}

function toArray<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}
