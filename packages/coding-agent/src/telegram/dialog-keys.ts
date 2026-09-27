/**
 * Callback-data encoding for Telegram dialogs.
 *
 * Telegram allows at most 64 bytes of UTF-8 per callback, so the payload is a
 * short token plus a small integer: `u:<token>:<index>`. The token is minted
 * per dialog (never derived from its content), and the index is a reserved
 * sentinel or an option position.
 */
import type { TelegramInlineKeyboardMarkup } from "./types";

const TOKEN_PATTERN = /^[\w-]{1,16}$/u;
const CALLBACK_PATTERN = /^u:([\w-]{1,16}):(-?\d{1,4})$/u;

/** Answers "cancel this dialog". */
export const CANCEL_INDEX = -1;
/** Multi-select "done" button. */
export const ASK_DONE_INDEX = -2;
/** ask-dialog "Other (type your own)" free-text button. */
export const ASK_OTHER_INDEX = -3;
/** Shortest index a dialog may encode. */
export const MIN_INDEX = ASK_OTHER_INDEX;
/** Longest button label dialogs render. */
export const BUTTON_LIMIT = 64;
/** The empty keyboard Telegram needs to strip buttons from a message. */
export const NO_KEYBOARD: TelegramInlineKeyboardMarkup = { inlineKeyboard: [] };

/** Encodes one dialog answer into Telegram callback data. */
export function uiCallbackData(token: string, index: number): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new RangeError(
			`Invalid dialog token "${String(token).slice(0, 40)}": expected 1–16 letters, digits, "_" or "-"`,
		);
	}
	if (!Number.isInteger(index) || index < MIN_INDEX || index > 9999) {
		throw new RangeError(
			`Invalid dialog answer index "${String(index)}": expected an integer from ${MIN_INDEX} to 9999`,
		);
	}
	return `u:${token}:${index}`;
}

/** Decodes callback data; null when it belongs to something else. */
export function parseUiCallback(data: unknown): { token: string; index: number } | null {
	const found = typeof data === "string" ? CALLBACK_PATTERN.exec(data) : null;
	return found === null ? null : { token: found[1], index: Number(found[2]) };
}
