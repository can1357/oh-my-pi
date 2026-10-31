/**
 * The server's retry wait on a failed assistant turn or an error, rendered for
 * a person at the point of display.
 *
 * The wait is structured data everywhere: `AssistantMessage.errorRetryAfterMs`,
 * an event's `retryAfterMs`, and on an `Error` rebuilt from a failed message a
 * `retry-after-ms` header (`retryWaitHeaders`), read back with the same header
 * reader every retry layer uses. Classifiers, retry decisions and credential
 * blocks read those numbers. The text is made only as the last step before it
 * reaches a person or an external client (`withRetryWait` in pi-utils), so no
 * classifier ever sees a wait written into an error message and mistakes its
 * digits for a status.
 *
 * A string these helpers return is for display only: never classify it,
 * compare it, persist it as a machine field or parse a wait back out of it. A
 * missing wait renders nothing — never a default, never the last wait shown,
 * never one scanned out of the text.
 */
import { withRetryWait } from "@oh-my-pi/pi-utils";
import { getHeadersFromError, getRetryAfterMsFromHeaders, retryWaitHeaders } from "./retry-after";

/** A failed assistant turn's error as a person reads it: its message and the server's wait. */
export function assistantErrorText(
	message: { readonly errorMessage?: string; readonly errorRetryAfterMs?: number },
	fallback = "Error",
): string {
	return withRetryWait(message.errorMessage || fallback, message.errorRetryAfterMs);
}

/** The wait an `Error` carries in its structured headers (`retryWaitHeaders`), if any. */
export function retryAfterMsOf(error: unknown): number | undefined {
	return getRetryAfterMsFromHeaders(getHeadersFromError(error));
}

/** `error`'s message as a person reads it, with the wait its headers carry. */
export function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return withRetryWait(text, retryAfterMsOf(error));
}

/**
 * An `Error` for a failed assistant turn: `message` is the turn's error text, and
 * the server's wait rides along as a `retry-after-ms` header (`retryWaitHeaders`),
 * never in the text.
 */
export function assistantTurnError(
	message: { readonly errorMessage?: string; readonly errorRetryAfterMs?: number },
	text: string = message.errorMessage || "Request failed",
	options?: ErrorOptions,
): Error {
	const error = new Error(text, options);
	const headers = retryWaitHeaders(message.errorRetryAfterMs);
	return headers ? Object.assign(error, { headers }) : error;
}
