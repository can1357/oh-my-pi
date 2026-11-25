import type { ImageContent } from "@oh-my-pi/pi-ai";
import { decodeBase64ImageData, isRecord, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { fieldQuestions, type HtmlFormData, type OptionNote } from "../../tools/html-form/data";
import { type HtmlForm, spansText } from "../../tools/html-form/parse";
import { MAX_IMAGE_INPUT_BYTES } from "../../utils/image-input";

/** Validate remote notes against the answered form and derive their labels as the local form does. */
export function parseRpcFormNotes(form: HtmlForm, data: HtmlFormData, submitted: unknown): OptionNote[] {
	if (submitted === undefined) return [];
	if (!Array.isArray(submitted) || submitted.length > 256) throw new Error("Invalid form notes");
	const questions = fieldQuestions(form);
	const seen = new Set<string>();
	let imageBytes = 0;
	return submitted.map((raw: unknown) => {
		if (
			!isRecord(raw) ||
			typeof raw.name !== "string" ||
			typeof raw.value !== "string" ||
			typeof raw.text !== "string" ||
			raw.text.length > 32768
		)
			throw new Error("Invalid option note");
		const name = raw.name,
			value = raw.value;
		const field = form.fields.find(
			f => f.kind === "choice" && f.name === name && f.options.some(o => o.value === value && !o.disabled),
		);
		if (!field || field.kind !== "choice") throw new Error("Note names an unknown or disabled option");
		const option = field.options.find(o => o.value === value && !o.disabled)!;
		const selected = data[name];
		if (!(Array.isArray(selected) ? selected.includes(value) : selected === value))
			throw new Error("Notes may only describe selected options");
		const key = JSON.stringify([name, value]);
		if (seen.has(key)) throw new Error("Duplicate option note");
		seen.add(key);
		if (raw.images !== undefined && !Array.isArray(raw.images)) throw new Error("Invalid note images");
		const images: ImageContent[] = ((raw.images ?? []) as unknown[]).map(image => {
			if (
				!isRecord(image) ||
				image.type !== "image" ||
				typeof image.mimeType !== "string" ||
				!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType) ||
				typeof image.data !== "string" ||
				image.data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4
			)
				throw new Error("Invalid or oversized note image");
			const decoded = decodeBase64ImageData(image.data);
			if (decoded.reason !== undefined) throw new Error(`Invalid note image: ${decoded.reason}`);
			imageBytes += decoded.bytes.length;
			if (imageBytes > MAX_IMAGE_INPUT_BYTES) throw new Error("Form note images exceed the image input size limit");
			return { type: "image", data: image.data, mimeType: image.mimeType };
		});
		return {
			name,
			question: questions.get(field) ?? name,
			option: spansText(option.label),
			value,
			text: raw.text,
			...(images.length ? { images } : {}),
		};
	});
}
