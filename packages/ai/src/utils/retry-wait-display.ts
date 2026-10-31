/**
 * The server's retry wait, rendered for a person at the point of display.
 *
 * The wait is structured data everywhere: `AssistantMessage.errorRetryAfterMs`,
 * an `Error`'s own numeric `retryAfterMs`, an event's `retryAfterMs`. Classifiers,
 * retry decisions and credential blocks read those numbers. These helpers turn
 * the number into text only as the last step before the text reaches a person or
 * an external client, so no classifier ever sees a wait written into an error
 * message and mistakes its digits for a status. A string these helpers return is
 * for display only: never classify it, compare it, persist it as a machine field
 * or parse a wait back out of it.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";

/** `retry after 30s`: the wait as a person reads it. */
export function formatRetryWait(retryAfterMs: number): string {
	return `retry after ${formatDuration(retryAfterMs)}`;
}

/** `text` with ` (retry after 30s)` when a wait is set; `text` unchanged otherwise. */
export function withRetryWait(text: string, retryAfterMs: number | undefined): string {
	if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return text;
	return `${text} (${formatRetryWait(retryAfterMs)})`;
}

/** A failed assistant turn's error as a person reads it: its message and the server's wait. */
export function assistantErrorText(
	message: { readonly errorMessage?: string; readonly errorRetryAfterMs?: number },
	fallback = "Error",
): string {
	return withRetryWait(message.errorMessage || fallback, message.errorRetryAfterMs);
}

/**
 * The wait an `Error` carries as its own numeric `retryAfterMs` property: set on
 * an error built from a failed assistant turn, so the code that displays the
 * error can render the wait the message text no longer carries.
 */
export function retryAfterMsOf(error: unknown): number | undefined {
	if (!(error instanceof Error) || !Object.hasOwn(error, "retryAfterMs")) return undefined;
	const value: unknown = Reflect.get(error, "retryAfterMs");
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `error`'s message as a person reads it, with the wait it carries. */
export function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return withRetryWait(text, retryAfterMsOf(error));
}

/**
 * An `Error` for a failed assistant turn: `message` is the turn's error text, and
 * the server's wait rides along as the numeric `retryAfterMs` property, never in
 * the text.
 */
export function assistantTurnError(
	message: { readonly errorMessage?: string; readonly errorRetryAfterMs?: number },
	text: string = message.errorMessage || "Request failed",
	options?: ErrorOptions,
): Error & { retryAfterMs?: number } {
	const error: Error & { retryAfterMs?: number } = new Error(text, options);
	if (message.errorRetryAfterMs !== undefined) error.retryAfterMs = message.errorRetryAfterMs;
	return error;
}
