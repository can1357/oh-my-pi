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
import { markRetryWaitRefused, type RefusedRetryWait } from "./retry-wait";

/** What a renderer needs off a failed turn: the two error texts and the server's wait. */
interface DisplayableFailure {
	readonly errorMessage?: string;
	/** What omp shows, when it differs from the provider's own text. Never classified. */
	readonly errorDisplayMessage?: string;
	readonly errorRetryAfterMs?: number;
	/** The refusal a lower layer recorded, so a thrown failure keeps the fact. */
	readonly errorRetryWaitRefusal?: RefusedRetryWait;
}

/**
 * A failed assistant turn's error as a person reads it: the shown text and the
 * server's wait. `errorDisplayMessage` is preferred because it is the text omp
 * built for a person — a request-dump path, a provider's remediation, a
 * refusal note — and `errorMessage` is the provider's own, which is what every
 * decision reads. A renderer wants the first; a classifier must never see it.
 */
export function assistantErrorText(message: DisplayableFailure, fallback = "Error"): string {
	return withRetryWait(message.errorDisplayMessage || message.errorMessage || fallback, message.errorRetryAfterMs);
}

/** The wait an `Error` carries in its structured headers (`retryWaitHeaders`), if any. */
export function retryAfterMsOf(error: unknown): number | undefined {
	return getRetryAfterMsFromHeaders(getHeadersFromError(error));
}

/**
 * `error`'s message as a person reads it, with the wait its headers carry. A
 * display text a thrown error carries (`thrownErrorDisplayText`) is shown in
 * place of its own message; nothing here reclassifies from either.
 */
export function errorText(error: unknown): string {
	const text = thrownErrorDisplayText(error) ?? (error instanceof Error ? error.message : String(error));
	return withRetryWait(text, retryAfterMsOf(error));
}

/** The display text a thrown error carries, when a layer attached one for a person to read. */
export function thrownErrorDisplayText(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("errorDisplayMessage" in error)) return undefined;
	const shown = error.errorDisplayMessage;
	return typeof shown === "string" && shown !== "" ? shown : undefined;
}

/**
 * An `Error` for a failed assistant turn. Its `message` is the **provider's own**
 * text, so every layer above that classifies, retries or blocks a credential
 * reads what the provider said. The server's wait rides along as a
 * `retry-after-ms` header (`retryWaitHeaders`), never in the text, and the text
 * omp shows rides along as `errorDisplayMessage` — separate, so a dump path that
 * names HOME can never reach a decision.
 *
 * A refusal the message carries rides along too, as the mark every reader of a
 * thrown failure looks for. Without it the words survive for whoever prints
 * this Error straight away and the fact is lost to everyone else — a recovery
 * layer replays a wait a lower layer already refused, and a relay that rebuilds
 * a message from this Error has nothing to record.
 */
export function assistantTurnError(
	message: DisplayableFailure,
	text: string = message.errorMessage || "Request failed",
	options?: ErrorOptions,
): Error {
	const error = new Error(text, options);
	const headers = retryWaitHeaders(message.errorRetryAfterMs);
	if (headers) Object.assign(error, { headers });
	if (message.errorDisplayMessage !== undefined) {
		Object.assign(error, { errorDisplayMessage: message.errorDisplayMessage });
	}
	if (message.errorRetryWaitRefusal !== undefined) markRetryWaitRefused(error, message.errorRetryWaitRefusal);
	return error;
}
