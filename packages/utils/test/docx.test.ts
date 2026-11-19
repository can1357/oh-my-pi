import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { convertToHtml, type DocxResult, images } from "@oh-my-pi/pi-utils/docx";

const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function deflatedZip(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let localOffset = 0;
	for (const name in files) {
		const payload = files[name];
		const encodedName = encoder.encode(name);
		const checksum = crc32(payload);
		const compressed = zlib.deflateRawSync(payload);
		const local = new Uint8Array(30 + encodedName.byteLength + compressed.byteLength);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0x0800, true);
		localView.setUint16(8, 8, true);
		localView.setUint32(14, checksum, true);
		localView.setUint32(18, compressed.byteLength, true);
		localView.setUint32(22, payload.byteLength, true);
		localView.setUint16(26, encodedName.byteLength, true);
		local.set(encodedName, 30);
		local.set(compressed, 30 + encodedName.byteLength);
		locals.push(local);

		const directory = new Uint8Array(46 + encodedName.byteLength);
		const directoryView = new DataView(directory.buffer);
		directoryView.setUint32(0, 0x02014b50, true);
		directoryView.setUint16(4, 20, true);
		directoryView.setUint16(6, 20, true);
		directoryView.setUint16(8, 0x0800, true);
		directoryView.setUint16(10, 8, true);
		directoryView.setUint32(16, checksum, true);
		directoryView.setUint32(20, compressed.byteLength, true);
		directoryView.setUint32(24, payload.byteLength, true);
		directoryView.setUint16(28, encodedName.byteLength, true);
		directoryView.setUint32(42, localOffset, true);
		directory.set(encodedName, 46);
		central.push(directory);
		localOffset += local.byteLength;
	}
	const localBytes = concatenate(locals);
	const centralBytes = concatenate(central);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, central.length, true);
	endView.setUint16(10, central.length, true);
	endView.setUint32(12, centralBytes.byteLength, true);
	endView.setUint32(16, localBytes.byteLength, true);
	return concatenate([localBytes, centralBytes, end]);
}

function xml(value: string): Uint8Array {
	return encoder.encode(value);
}

function docx(documentXml: string, extras: Readonly<Record<string, Uint8Array>> = {}): Uint8Array {
	return deflatedZip({
		"[Content_Types].xml": xml(
			`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		),
		"_rels/.rels": xml(
			`<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="word/document.xml"/></Relationships>`,
		),
		"word/document.xml": xml(documentXml),
		...extras,
	});
}

describe("DOCX to HTML", () => {
	it("matches mammoth for headings, formatting, style diagnostics, breaks, and footnotes", async () => {
		const document = docx(
			`<?xml version="1.0"?><w:document xmlns:w="${WML}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title &amp; More</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>IU</w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t>Strike</w:t></w:r><w:r><w:br/><w:t>line</w:t><w:br w:type="page"/><w:t>page</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>sub</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>sup</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Mystery"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Odd"/></w:rPr><w:t>Unknown</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p></w:body></w:document>`,
			{
				"word/styles.xml": xml(
					`<w:styles xmlns:w="${WML}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Mystery"><w:name w:val="Mystery Style"/></w:style><w:style w:type="character" w:styleId="Odd"><w:name w:val="Odd Style"/></w:style></w:styles>`,
				),
				"word/footnotes.xml": xml(
					`<w:footnotes xmlns:w="${WML}"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Foot </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>note</w:t></w:r></w:p></w:footnote></w:footnotes>`,
				),
			},
		);
		const expected: DocxResult = {
			value: '<h1>Title &amp; More</h1><p><strong>Bold</strong> and <em>IU</em><s>Strike</s><br />linepage<sub>sub</sub><sup>sup</sup></p><p>Unknown<sup><a href="#footnote-2" id="footnote-ref-2">[1]</a></sup></p><ol><li id="footnote-2"><p>Foot <strong>note</strong> <a href="#footnote-ref-2">↑</a></p></li></ol>',
			messages: [
				{ type: "warning", message: "Unrecognised paragraph style: 'Mystery Style' (Style ID: Mystery)" },
				{ type: "warning", message: "Unrecognised run style: 'Odd Style' (Style ID: Odd)" },
			],
		};
		expect(await convertToHtml({ buffer: document })).toEqual(expected);

		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-docx-"));
		const filename = path.join(directory, "fixture.docx");
		try {
			await Bun.write(filename, document);
			expect(await convertToHtml({ path: filename })).toEqual(expected);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("matches mammoth for nested ordered and unordered numbering", async () => {
		const document = docx(
			`<w:document xmlns:w="${WML}"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Two</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Bullet A</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Bullet B</w:t></w:r></w:p></w:body></w:document>`,
			{
				"word/numbering.xml": xml(
					`<w:numbering xmlns:w="${WML}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
				),
			},
		);
		expect(await convertToHtml({ buffer: document })).toEqual({
			value: "<ol><li>One<ol><li>Nested</li></ol></li><li>Two</li></ol><ul><li>Bullet A<ul><li>Bullet B</li></ul></li></ul>",
			messages: [],
		});
	});

	it("matches mammoth for hyperlinks and horizontally and vertically merged table cells", async () => {
		const document = docx(
			`<w:document xmlns:w="${WML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><w:body><w:p><w:hyperlink r:id="rId5"><w:r><w:rPr><w:i/></w:rPr><w:t>Example</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> &amp; </w:t></w:r><w:hyperlink w:anchor="spot"><w:r><w:t>Jump</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Header AB</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Header C</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Rowspan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
			{
				"word/_rels/document.xml.rels": xml(
					`<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId5" Type="${OFFICE_RELATIONSHIPS}/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/></Relationships>`,
				),
			},
		);
		expect(await convertToHtml({ buffer: document })).toEqual({
			value: '<p><a href="https://example.com/?a=1&amp;b=2"><em>Example</em></a> &amp; <a href="#spot">Jump</a></p><table><tr><td colspan="2"><p>Header AB</p></td><td><p>Header C</p></td></tr><tr><td rowspan="2"><p>Rowspan</p></td><td><p>B1</p></td><td><p>C1</p></td></tr><tr><td><p>B2</p></td><td><p>C2</p></td></tr></table>',
			messages: [],
		});
	});

	it("matches the converter's mammoth image callback byte-for-byte", async () => {
		const png = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
		);
		const document = docx(
			`<w:document xmlns:w="${WML}" xmlns:r="${OFFICE_RELATIONSHIPS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture" descr="Pixel"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
			{
				"[Content_Types].xml": xml(
					`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
				),
				"word/_rels/document.xml.rels": xml(
					`<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rIdImg" Type="${OFFICE_RELATIONSHIPS}/image" Target="media/image1.png"/></Relationships>`,
				),
				"word/media/image1.png": png,
			},
		);
		let imageCount = 0;
		const convertImage = images.imgElement(image => {
			imageCount++;
			const contentType = image.contentType || "image/png";
			return image.read("base64").then(base64 => ({
				src: `data:${contentType};base64,${base64.slice(0, 0)}`,
				alt: `image_${imageCount}`,
			}));
		});
		expect(await convertToHtml({ buffer: document }, { convertImage })).toEqual({
			value: '<p><img alt="image_1" src="data:image/png;base64," /></p>',
			messages: [],
		});
		expect(await convertToHtml({ buffer: document })).toEqual({
			value: '<p><img alt="Pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" /></p>',
			messages: [],
		});
	});
});
