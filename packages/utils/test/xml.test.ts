import { describe, expect, test } from "bun:test";
import { XMLParser } from "../src/xml";

const converterOptions = {
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	processEntities: { maxTotalExpansions: 1_000_000 },
} as const;

const parser = new XMLParser(converterOptions);

describe("XMLParser converter fixtures", () => {
	test("matches captured fast-xml-parser output for a representative PPTX slide", () => {
		const xml = `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Roadmap &amp; Plan</a:t></a:r><a:r><a:t><![CDATA[ <Q3> ]]></a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		expect(parser.parse(xml)).toEqual({
			"?xml": { "@_version": "1.0" },
			"p:sld": {
				"p:cSld": {
					"p:spTree": {
						"p:sp": [
							{
								"p:nvSpPr": { "p:cNvPr": { "@_id": "2", "@_name": "Title" } },
								"p:txBody": {
									"a:p": { "a:r": [{ "a:t": "Roadmap & Plan" }, { "a:t": " <Q3> " }] },
								},
							},
							{ "p:txBody": { "a:p": { "a:r": { "a:t": "Second" } } } },
						],
					},
				},
				"@_xmlns:p": "p",
				"@_xmlns:a": "a",
			},
		});
	});

	test("matches captured fast-xml-parser output for XLSX sheet and shared strings", () => {
		const sheet = `<?xml version="1.0"?><worksheet xmlns="sheet"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42.5</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><r><t xml:space="preserve"> Hello </t></r><r><t>world</t></r></is></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>`;
		expect(parser.parse(sheet)).toEqual({
			"?xml": { "@_version": "1.0" },
			worksheet: {
				sheetData: {
					row: [
						{
							c: [
								{ v: 0, "@_r": "A1", "@_t": "s" },
								{ v: 42.5, "@_r": "B1" },
							],
							"@_r": "1",
						},
						{
							c: [
								{
									is: { r: [{ t: { "#text": "Hello", "@_xml:space": "preserve" } }, { t: "world" }] },
									"@_r": "A2",
									"@_t": "inlineStr",
								},
								{ v: 1, "@_r": "B2", "@_t": "b" },
							],
							"@_r": "2",
						},
					],
				},
				"@_xmlns": "sheet",
			},
		});

		const sharedStrings = `<sst count="3" uniqueCount="2"><si><t>Name &amp; Role</t></si><si><r><t>North</t></r><r><t><![CDATA[ & South]]></t></r></si></sst>`;
		expect(parser.parse(sharedStrings)).toEqual({
			sst: {
				si: [{ t: "Name & Role" }, { r: [{ t: "North" }, { t: " & South" }] }],
				"@_count": "3",
				"@_uniqueCount": "2",
			},
		});
	});

	test("matches captured fast-xml-parser output for an EPUB OPF", () => {
		const xml = `<?xml version="1.0"?><package version="3.0" xmlns:dc="dc"><metadata><dc:title id="title">A &amp; B</dc:title><dc:creator>Ada</dc:creator><dc:creator>Grace</dc:creator><dc:description>Before <em>bold</em> after</dc:description></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
		expect(parser.parse(xml)).toEqual({
			"?xml": { "@_version": "1.0" },
			package: {
				metadata: {
					"dc:title": { "#text": "A & B", "@_id": "title" },
					"dc:creator": ["Ada", "Grace"],
					"dc:description": { em: "bold", "#text": "Beforeafter" },
				},
				manifest: {
					item: [
						{ "@_id": "c1", "@_href": "ch1.xhtml", "@_media-type": "application/xhtml+xml" },
						{ "@_id": "c2", "@_href": "ch2.xhtml" },
					],
				},
				spine: { itemref: [{ "@_idref": "c1" }, { "@_idref": "c2" }] },
				"@_version": "3.0",
				"@_xmlns:dc": "dc",
			},
		});
	});
});

describe("XMLParser option and content edges", () => {
	test("handles arrays, self-closing tags, mixed content, entities, CDATA, comments, and processing instructions", () => {
		const xml = `<!-- comment --><?work ignored?><r code="001"><item/><item a="2"> 01 </item><mixed>before<b>bold</b>after &lt; &#65;</mixed><data><![CDATA[x < y &amp; z]]></data></r>`;
		expect(parser.parse(xml)).toEqual({
			"?work": "",
			r: {
				item: ["", { "#text": 1, "@_a": "2" }],
				mixed: { b: "bold", "#text": "beforeafter < &#65;" },
				data: "x < y &amp; z",
				"@_code": "001",
			},
		});
	});

	test("honors value parsing, trimming, attributes, and isArray", () => {
		const xml = `<r a="01" b="true"><a> 1 </a><b> false </b><empty/></r>`;
		expect(new XMLParser({ ...converterOptions, parseTagValue: false }).parse(xml)).toEqual({
			r: { a: "1", b: "false", empty: "", "@_a": "01", "@_b": "true" },
		});
		expect(new XMLParser({ ...converterOptions, parseAttributeValue: true }).parse(xml)).toEqual({
			r: { a: 1, b: false, empty: "", "@_a": 1, "@_b": true },
		});
		expect(new XMLParser({ ...converterOptions, trimValues: false }).parse(xml)).toEqual({
			r: { a: " 1 ", b: " false ", empty: "", "@_a": "01", "@_b": "true" },
		});
		expect(
			new XMLParser({ ...converterOptions, isArray: (name, path) => name === "a" && path === "r.a" }).parse(xml),
		).toEqual({ r: { a: [1], b: false, empty: "", "@_a": "01", "@_b": "true" } });
		expect(new XMLParser().parse(`<r a="ignored"><x>1</x></r>`)).toEqual({ r: { x: 1 } });
	});
});
