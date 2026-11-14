import { pdfToMarkdown } from "@oh-my-pi/pi-natives";
import { prompt } from "@oh-my-pi/pi-utils";
import pdfTextIncompleteTemplate from "../../../prompts/tools/pdf-text-incomplete.md" with { type: "text" };
import type { ConversionResult, Converter, StreamInfo } from "../../types";

const EXTENSIONS = [".pdf"];
const MIMETYPES = ["application/pdf", "application/x-pdf"];

/** Converts PDF buffers to Markdown through the native `pdf-inspector` bridge. */
export class PdfConverter implements Converter {
	name = "pdf";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
			return true;
		}
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) {
			return true;
		}
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const result = await pdfToMarkdown(input);
		const notice =
			result.pagesNeedingOcr.length > 0
				? prompt.render(pdfTextIncompleteTemplate, {
						pages: result.pagesNeedingOcr.join(", "),
						firstPage: result.pagesNeedingOcr[0],
					})
				: undefined;

		const conversion: ConversionResult = {
			markdown: notice ? [result.markdown, notice].filter(Boolean).join("\n\n") : result.markdown,
		};
		if (result.title !== undefined) conversion.title = result.title;
		return conversion;
	}
}
