/**
 * Runtime coverage for the in-house markit document engine (src/markit), which
 * replaced the `markit-ai` package. Each format is generated in-memory via the
 * shared zip util (src/utils/zip) — no external fixtures — and converted through
 * the public wrapper (src/utils/markit), locking: docx text, xlsx tables, pptx
 * slides, epub metadata+spine, shared HTML-table normalization, image
 * extraction, the nested/relative zip path resolution regression surface, and
 * the unsupported-format error contract.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertBufferWithMarkit, convertFileWithMarkit } from "@pk-nerdsaver-ai/pi-coding-agent/utils/markit";
import { zip } from "@pk-nerdsaver-ai/pi-coding-agent/utils/zip";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function makeDocx(bodyXml: string): Uint8Array {
	return zip({
		"[Content_Types].xml": enc(
			`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		),
		"_rels/.rels": enc(
			`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		),
		"word/document.xml": enc(
			`<?xml version="1.0"?><w:document xmlns:w="${WML}"><w:body>${bodyXml}</w:body></w:document>`,
		),
	});
}

describe("markit converters", () => {
	it("converts docx paragraphs to markdown", async () => {
		const docx = makeDocx(
			`<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>`,
		);
		const result = await convertBufferWithMarkit(docx, ".docx");
		expect(result.ok).toBe(true);
		expect(result.content).toBe("First paragraph.\n\nSecond paragraph.");
	});

	it("converts xlsx sheets to markdown tables", async () => {
		const xlsx = zip({
			"xl/workbook.xml": enc(
				`<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			),
			"xl/_rels/workbook.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
			),
			"xl/worksheets/sheet1.xml": enc(
				`<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c><c t="inlineStr"><is><t>Age</t></is></c></row><row><c t="inlineStr"><is><t>Alice</t></is></c><c><v>30</v></c></row></sheetData></worksheet>`,
			),
		});
		const result = await convertBufferWithMarkit(xlsx, ".xlsx");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("## People");
		expect(result.content).toContain("| Name | Age |");
		expect(result.content).toContain("| --- | --- |");
		expect(result.content).toContain("| Alice | 30 |");
	});

	it("reads an xlsx worksheet through an absolute (/-prefixed) rel target", async () => {
		const xlsx = zip({
			"xl/workbook.xml": enc(
				`<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			),
			"xl/_rels/workbook.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
			),
			"xl/worksheets/sheet1.xml": enc(
				`<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>Header</t></is></c></row><row><c><v>42</v></c></row></sheetData></worksheet>`,
			),
		});
		const result = await convertBufferWithMarkit(xlsx, ".xlsx");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("| Header |");
		expect(result.content).toContain("| 42 |");
	});

	it("converts pptx slides with a title heading and body text", async () => {
		const pptx = zip({
			"ppt/presentation.xml": enc(
				`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
			),
			"ppt/slides/slide1.xml": enc(
				`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>The Title</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Body line</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
			),
		});
		const result = await convertBufferWithMarkit(pptx, ".pptx");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("# The Title");
		expect(result.content).toContain("Body line");
	});

	it("extracts a pptx image through a ../media relative rel target into imageDir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "markit-pptx-"));
		try {
			const pptx = zip({
				"ppt/presentation.xml": enc(
					`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
				),
				"ppt/_rels/presentation.xml.rels": enc(
					`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
				),
				"ppt/slides/slide1.xml": enc(
					`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr name="Pic1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
				),
				"ppt/slides/_rels/slide1.xml.rels": enc(
					`<?xml version="1.0"?><Relationships><Relationship Id="rId2" Target="../media/image1.png"/></Relationships>`,
				),
				"ppt/media/image1.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			});
			const pptxPath = path.join(dir, "deck.pptx");
			const imageDir = path.join(dir, "imgs");
			await Bun.write(pptxPath, pptx);
			const result = await convertFileWithMarkit(pptxPath, undefined, { imageDir });
			expect(result.ok).toBe(true);
			const written = await fs.readdir(imageDir);
			expect(written).toHaveLength(1);
			expect(result.content).toContain(`](${path.join(imageDir, written[0]!)})`);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("converts epub spine, normalizes HTML tables, and resolves a non-root OPF basePath", async () => {
		const epub = zip({
			"META-INF/container.xml": enc(
				`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
			),
			"OEBPS/content.opf": enc(
				`<?xml version="1.0"?><package><metadata xmlns:dc="dc"><dc:title>Nested Book</dc:title><dc:creator>Ada</dc:creator></metadata><manifest><item id="c1" href="text/ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
			),
			"OEBPS/text/ch1.xhtml": enc(
				`<html><body><h2>Chapter One</h2><p>Body text.</p><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table></body></html>`,
			),
		});
		const result = await convertBufferWithMarkit(epub, ".epub");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("**Title:** Nested Book");
		expect(result.content).toContain("**Authors:** Ada");
		expect(result.content).toContain("## Chapter One");
		expect(result.content).toContain("Body text.");
		// normalizeTablesHtml promotes the first row to a header so GFM renders a table.
		expect(result.content).toContain("| A | B |");
		expect(result.content).toContain("| --- | --- |");
	});

	it("reports an unsupported format instead of emitting garbage", async () => {
		const rtf = enc("{\\rtf1\\ansi binary-ish}");
		const result = await convertBufferWithMarkit(rtf, ".rtf");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unsupported format");
	});
});
