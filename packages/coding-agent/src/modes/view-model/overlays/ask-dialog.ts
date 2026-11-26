import type { ImageContent } from "@oh-my-pi/pi-ai";
import { sanitizeCarriageReturns } from "../../../utils/render-utils";

/** One selectable answer in an ask dialog. */
export interface ExtensionAskDialogOption {
	label: string;
	description?: string;
	preview?: string;
}

/** Question and answer choices displayed by the ask dialog. */
export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
}

/** Prompt text and the images pasted into it (custom answers and notes). */
export interface AskDialogPromptValue {
	text: string;
	images?: ImageContent[];
}

/** A prompt left without submitting: what it still held, offered again when the custom answer reopens. */
export interface AskDialogPromptDraft {
	draft: AskDialogPromptValue;
}

/** Submitted answer to one dialog question. */
export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	customInputImages?: ImageContent[];
	note?: string;
	noteImages?: ImageContent[];
	/** Label of the option the note is on; unset when it is on the custom answer. */
	noteOption?: string;
	timedOut?: boolean;
}

/** Answers submitted from the dialog. */
export interface ExtensionAskDialogSubmitResult {
	kind: "submit";
	results: ExtensionAskDialogResultItem[];
}

/** Request to discuss the question instead of answering it. */
export interface ExtensionAskDialogChatResult {
	kind: "chat";
}

/** Completed dialog action, distinct from cancellation. */
export type ExtensionAskDialogResult = ExtensionAskDialogSubmitResult | ExtensionAskDialogChatResult;

/** What a custom-answer or note prompt asks: the host shows `title` over `question` (`HookEditorOptions.question`). */
export interface AskDialogPrompt {
	/** `Custom answer`, `Note for <option>`. */
	title: string;
	/** The question being answered, verbatim. */
	question: string;
}

/**
 * Coerce untrusted dialog questions into a render-safe shape. The live ask
 * dialog is reached from the public `askDialog` extension surface and from
 * streamed tool args, where a question entry can arrive with a missing or
 * non-string `question` field. The render helpers (`replaceTabs`,
 * `renderQuestionTitle`, `foldQuestionSpans`) assume strings, so a malformed
 * entry throws and takes down the whole TUI render loop. Mirrors
 * `normalizeRenderQuestions` on the transcript path.
 */
export function normalizeDialogQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
	if (!Array.isArray(questions)) return [];
	const out: ExtensionAskDialogQuestion[] = [];
	for (const entry of questions) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<ExtensionAskDialogQuestion>;
		const options: ExtensionAskDialogOption[] = [];
		if (Array.isArray(q.options)) {
			for (const opt of q.options) {
				if (!opt || typeof opt !== "object") continue;
				const o = opt as Partial<ExtensionAskDialogOption>;
				options.push({
					// The label is a caller-supplied correlation key echoed verbatim
					// in results (matching the guest path) — sanitize only the
					// display copy (`displayOptionLabels`).
					label: typeof o.label === "string" ? o.label : "",
					...(typeof o.description === "string" ? { description: sanitizeCarriageReturns(o.description) } : {}),
					...(typeof o.preview === "string" ? { preview: sanitizeCarriageReturns(o.preview) } : {}),
				});
			}
		}
		out.push({
			// The id is a caller-supplied correlation key echoed verbatim in
			// results; the dialog never shows it.
			id: typeof q.id === "string" ? q.id : "?",
			// The question is echoed verbatim in results (matching the guest
			// path) — sanitize only the display copy (`wrapQuestionTitle`).
			question: typeof q.question === "string" ? q.question : "",
			...(typeof q.header === "string" ? { header: sanitizeCarriageReturns(q.header) } : {}),
			options,
			...(typeof q.multi === "boolean" ? { multi: q.multi } : {}),
			...(Number.isInteger(q.recommended) ? { recommended: q.recommended } : {}),
		});
	}
	return out;
}
