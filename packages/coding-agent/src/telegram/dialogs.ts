/**
 * Renders the Telegram side of an extension dialog: prompt markdown plus an
 * inline keyboard, for the four `ExtensionUIContext` primitives and for the
 * structured ask dialog.
 *
 * Every dynamic value goes through `mdText`, labels are clipped to the button
 * budget, and callback data carries only a token + index (`dialog-keys.ts`).
 * Lifeos answered RPC select frames whose options carried its own sentinels
 * (`"✔ Done selecting"`, `"Other (type your own)"`); the native ask dialog is
 * structured, so those labels are ordinary options here and the multi-select
 * "Done" row is the desk's own button.
 */
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionUISelectItem,
} from "../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel } from "../extensibility/extensions/types";
import { ASK_DONE_INDEX, ASK_OTHER_INDEX, BUTTON_LIMIT, CANCEL_INDEX, uiCallbackData } from "./dialog-keys";
import { mdText } from "./rich";
import { clip, passage, quoteBlock } from "./text";
import type { TelegramInlineKeyboardMarkup } from "./types";

/** Label of the free-text option the desk appends to every question. */
export const OTHER_LABEL = "Other (type your own)";
/** Label of the multi-select submit button. */
export const DONE_LABEL = "Done";
const TITLE_MARK = "❓";
const TITLE_LIMIT = 200;
const MESSAGE_LIMIT = 1500;
const OPTION_LABEL_LIMIT = 60;
const VISIBLE_OPTIONS = 20;
const MULTI_HINT = "_Select any number of options, then press Done._";
const REPLY_HINT = "Write your answer as a message in this topic.";

/** The dialog primitives the Telegram renderer knows how to present. */
export interface UiRequest {
	method: "select" | "confirm" | "input" | "editor" | "notify";
	title?: string;
	message?: string;
	placeholder?: string;
	prefill?: string;
	options?: readonly ExtensionUISelectItem[];
}

/** A rendered prompt: message text, keyboard and whether free text answers it. */
export interface UiPrompt {
	text: string;
	replyMarkup: TelegramInlineKeyboardMarkup | null;
	expectsReply: boolean;
}

/** Option labels of a select, in button order. */
export function selectLabels(options: readonly ExtensionUISelectItem[]): string[] {
	return options.map(getExtensionUISelectOptionLabel);
}

function selectRows(options: readonly ExtensionUISelectItem[], token: string): TelegramInlineKeyboardMarkup {
	const rows = options.map((option, index) => {
		const label = getExtensionUISelectOptionLabel(option);
		const description = typeof option === "string" ? "" : (option.description ?? "");
		const text = description === "" ? label : `${label} — ${description}`;
		return [{ text: clip(text, BUTTON_LIMIT), callbackData: uiCallbackData(token, index) }];
	});
	rows.push([{ text: "Cancel", callbackData: uiCallbackData(token, CANCEL_INDEX) }]);
	return { inlineKeyboard: rows };
}

function promptHead(request: UiRequest): string[] {
	const lines: string[] = [];
	const title = passage(request.title, TITLE_LIMIT);
	const message = passage(request.message, MESSAGE_LIMIT);
	const placeholder =
		request.method === "input" || request.method === "editor" ? passage(request.placeholder, MESSAGE_LIMIT) : "";
	const prefill = request.method === "editor" ? passage(request.prefill, MESSAGE_LIMIT) : "";
	if (title !== "") lines.push(`## ${TITLE_MARK} ${mdText(title)}`);
	if (message !== "") lines.push(mdText(message));
	if (prefill !== "") lines.push(quoteBlock(mdText(prefill)));
	if (placeholder !== "") lines.push(`_${mdText(placeholder)}_`);
	if (lines.length === 0) lines.push("Extension dialog.");
	return lines;
}

/** The escaped head of a prompt, without its keyboard. */
export function dialogHead(request: UiRequest): string {
	return promptHead(request).join("\n");
}

/** Renders one `ExtensionUIContext` request for Telegram. */
export function uiPrompt(request: UiRequest, token: string): UiPrompt {
	const text = dialogHead(request);
	if (request.method === "select") {
		return { text, replyMarkup: selectRows(request.options ?? [], token), expectsReply: false };
	}
	if (request.method === "confirm") {
		const inlineKeyboard = [
			[
				{ text: "Yes", callbackData: uiCallbackData(token, 1) },
				{ text: "No", callbackData: uiCallbackData(token, 0) },
			],
		];
		return { text, replyMarkup: { inlineKeyboard }, expectsReply: false };
	}
	if (request.method === "input" || request.method === "editor") {
		const inlineKeyboard = [[{ text: "Cancel", callbackData: uiCallbackData(token, CANCEL_INDEX) }]];
		return { text: `${text}\n\n${REPLY_HINT}`, replyMarkup: { inlineKeyboard }, expectsReply: true };
	}
	return { text, replyMarkup: null, expectsReply: false };
}

/** Numbered, escaped option list shown above an ask question's buttons. */
export function askOptionLines(options: readonly ExtensionAskDialogOption[], recommended?: number): string[] {
	return options.slice(0, VISIBLE_OPTIONS).map((option, index) => {
		const description =
			option.description === undefined || option.description === "" ? "" : ` — ${mdText(option.description)}`;
		const mark = index === recommended ? " ⭐" : "";
		return `${index + 1}. **${mdText(clip(option.label, OPTION_LABEL_LIMIT))}**${description}${mark}`;
	});
}

/** Renders one ask question: header, optional progress and the option list. */
export function askQuestionText(
	question: ExtensionAskDialogQuestion,
	at: number,
	total: number,
	multi: boolean,
): string {
	const lines = [`## ${TITLE_MARK} ${mdText(passage(question.question, TITLE_LIMIT))}`];
	const header = passage(question.header, MESSAGE_LIMIT);
	if (header !== "") lines.push(`_${mdText(header)}_`);
	if (total > 1) lines.push(`_Question ${at} of ${total}_`);
	lines.push("", ...askOptionLines(question.options, question.recommended));
	const hidden = question.options.length - VISIBLE_OPTIONS;
	if (hidden > 0) lines.push(`_…and ${hidden} more_`);
	if (multi) lines.push("", MULTI_HINT);
	return lines.join("\n");
}

/** Renders one ask question's keyboard: options, optional Done, Other, Cancel. */
export function askQuestionKeyboard(
	question: ExtensionAskDialogQuestion,
	token: string,
	selected: ReadonlySet<string>,
	multi: boolean,
): TelegramInlineKeyboardMarkup {
	const rows = question.options.map((option, index) => {
		const recommended = question.recommended === index;
		const check = multi && selected.has(option.label) ? "☑ " : "";
		const text = clip(`${check}${option.label}${recommended ? " ⭐" : ""}`, BUTTON_LIMIT);
		return [{ text, callbackData: uiCallbackData(token, index) }];
	});
	if (multi) rows.push([{ text: DONE_LABEL, callbackData: uiCallbackData(token, ASK_DONE_INDEX) }]);
	rows.push([{ text: OTHER_LABEL, callbackData: uiCallbackData(token, ASK_OTHER_INDEX) }]);
	rows.push([{ text: "Cancel", callbackData: uiCallbackData(token, CANCEL_INDEX) }]);
	return { inlineKeyboard: rows };
}

/** Text shown while a question waits for a free-text "Other" answer. */
export function askReplyText(question: ExtensionAskDialogQuestion, at: number, total: number): string {
	return `${askQuestionText(question, at, total, false)}\n\n_${mdText(OTHER_LABEL)}: ${REPLY_HINT}_`;
}
