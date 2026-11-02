import type { AssistantMessage } from "../types";

type ErrorText = Pick<AssistantMessage, "errorMessage" | "errorDisplayMessage">;

/**
 * The response's retry timing (`errorRetryAfterMs`) as headers, for an error
 * built from a failed turn. Retry-hint extraction reads a thrown error's
 * headers; the turn's text carries only the provider's words.
 */
export function errorRetryHeaders(message: Pick<AssistantMessage, "errorRetryAfterMs">): Headers | undefined {
	return message.errorRetryAfterMs === undefined
		? undefined
		: new Headers({ "retry-after-ms": String(message.errorRetryAfterMs) });
}

/**
 * How omp shows a failure: `errorDisplayMessage` when the provider stored
 * one, else `errorMessage`. Display only: the text can name local paths, so
 * no decision about the error may read it.
 */
export function errorDisplayText(message: ErrorText): string | undefined {
	return message.errorDisplayMessage ?? message.errorMessage;
}

/**
 * Apply one edit, such as a "Retry budget exhausted" prefix, to a failure's
 * text and to how omp shows it, so the two stay in step.
 */
export function editErrorText(message: ErrorText, edit: (text: string) => string): void {
	message.errorMessage = edit(message.errorMessage ?? "");
	if (message.errorDisplayMessage !== undefined) message.errorDisplayMessage = edit(message.errorDisplayMessage);
}

/**
 * Clear a failure's text, how omp shows it, and the response's retry delay
 * together, so none outlives the others on a retried or recovered turn.
 */
export function clearErrorText(
	message: Pick<AssistantMessage, "errorMessage" | "errorDisplayMessage" | "errorRetryAfterMs">,
): void {
	message.errorMessage = undefined;
	message.errorDisplayMessage = undefined;
	message.errorRetryAfterMs = undefined;
}
