import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { decodeBase64ImageData, isRecord, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { fieldQuestions, type HtmlFormValue, type OptionNote } from "../../tools/html-form/data";
import { type ChoiceField, type HtmlForm, spansText } from "../../tools/html-form/parse";
import { MAX_IMAGE_INPUT_BYTES, webpExclusionForModel } from "../../utils/image-input";
import { loadImageAttachmentInput } from "../../utils/image-loading";

/** Validate remote notes against the answered form and derive their labels as the local form does. */
export function parseRpcFormNotes(
	form: HtmlForm,
	selections: ReadonlyMap<ChoiceField, HtmlFormValue | undefined>,
	submitted: unknown,
	acceptImages = false,
): OptionNote[] {
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
		const candidates = form.fields.filter(
			(f): f is ChoiceField =>
				f.kind === "choice" && f.name === name && f.options.some(o => o.value === value && !o.disabled),
		);
		if (!candidates.length) throw new Error("Note names an unknown or disabled option");
		// Hidden defaults and same-name text values are not evidence of a selected choice.
		const field = candidates.find(candidate => {
			const selected = selections.get(candidate);
			return Array.isArray(selected) ? selected.includes(value) : selected === value;
		});
		if (!field) throw new Error("Notes may only describe selected options");
		const option = field.options.find(o => o.value === value && !o.disabled)!;
		const key = JSON.stringify([name, value]);
		if (seen.has(key)) throw new Error("Duplicate option note");
		seen.add(key);
		const submittedImages = raw.images;
		if (submittedImages !== undefined && !Array.isArray(submittedImages)) throw new Error("Invalid note images");
		if (submittedImages?.length && !acceptImages) throw new Error("This form does not accept note images");
		const images: ImageContent[] = (submittedImages ?? []).map((image: unknown) => {
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

/** Apply the same decode, minimum-size and encoder policy as other inbound image attachments. */
export async function normalizeRpcFormNoteImages(notes: OptionNote[], model?: Model): Promise<OptionNote[]> {
	const normalized: OptionNote[] = [];
	for (const note of notes) {
		if (!note.images?.length) {
			normalized.push(note);
			continue;
		}
		const images: ImageContent[] = [];
		for (const image of note.images) {
			const loaded = await loadImageAttachmentInput({
				image,
				label: "RPC form note",
				uri: "rpc://form-note",
				autoResize: true,
				excludeWebP: webpExclusionForModel(model),
			});
			if (!loaded) throw new Error("Unsupported form note image");
			images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
		}
		normalized.push({ ...note, images });
	}
	return normalized;
}
