// Adapted from markit-ai (MIT). See ../NOTICE.
import * as path from "node:path";
import mammoth from "@oh-my-pi/pi-utils/docx";
import { createTurndown, normalizeTablesHtml } from "../../utils/turndown";
import type { ConversionResult, Converter, StreamInfo } from "../types";

const EXTENSIONS = [".docx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

export class DocxConverter implements Converter {
	name = "docx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
			return true;
		}
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) {
			return true;
		}
		return false;
	}

	async convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult> {
		const imageDir = streamInfo.imageDir;
		let imageCount = 0;
		const convertImage = imageDir
			? mammoth.images.imgElement(image => {
					imageCount++;
					const ext = (image.contentType?.split("/")[1] || "png").replace("jpeg", "jpg");
					const filename = `image_${imageCount}.${ext}`;
					const filepath = path.join(imageDir, filename);
					return image.read("base64").then(async base64 => {
						await Bun.write(filepath, Buffer.from(base64, "base64"));
						return { src: filepath, alt: `image_${imageCount}` };
					});
				})
			: mammoth.images.imgElement(image => {
					imageCount++;
					const contentType = image.contentType || "image/png";
					return image.read("base64").then(base64 => {
						return {
							src: `data:${contentType};base64,${base64.slice(0, 0)}`,
							alt: `image_${imageCount}`,
						};
					});
				});
		const { value: html } = await mammoth.convertToHtml({ buffer: input }, { convertImage });
		const turndown = createTurndown();
		let markdown = turndown.turndown(normalizeTablesHtml(html));
		// Replace data URI images with comment placeholders when no imageDir
		if (!imageDir) {
			markdown = markdown.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, "<!-- image: $1 -->");
		}
		return { markdown: markdown.trim() };
	}
}
