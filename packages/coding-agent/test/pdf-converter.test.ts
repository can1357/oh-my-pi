import { afterEach, describe, expect, it, vi } from "bun:test";
import * as piNatives from "@oh-my-pi/pi-natives";
import { PdfConverter } from "../src/markit/converters/pdf";

describe("PdfConverter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps accepting PDF extensions and MIME types", () => {
		const converter = new PdfConverter();

		expect(converter.accepts({ extension: ".pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf; charset=binary" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/x-pdf" })).toBe(true);
		expect(converter.accepts({ extension: ".txt", mimetype: "text/plain" })).toBe(false);
	});

	it("returns a browser and OCR notice for an image-only PDF", async () => {
		vi.spyOn(piNatives, "pdfToMarkdown").mockResolvedValue({
			markdown: "",
			pageCount: 3,
			pagesNeedingOcr: [1, 3],
			hasEncodingIssues: false,
		});

		const result = await new PdfConverter().convert(Buffer.from("image-only pdf"), { extension: ".pdf" });

		expect(result.markdown).toBe(
			"Text extraction is incomplete for PDF pages 1, 3. Use the browser prelude to render those pages or OCR them.",
		);
		expect(result.markdown.length).toBeGreaterThan(0);
	});
});
