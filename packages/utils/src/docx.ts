/** Behavior-compatible reimplementation of mammoth's used surface. */
export {
	type ConvertToHtmlOptions,
	convertToHtml,
	type DocxImage,
	type DocxInput,
	type DocxMessage,
	type DocxResult,
	type ImageAttributeConverter,
	type ImageAttributes,
	type ImageConverter,
	images,
} from "./docx/converter";

import { convertToHtml, images } from "./docx/converter";

/** Mammoth-shaped default export for drop-in consumer imports. */
const docx = { convertToHtml, images };

export default docx;
