import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";

/** Inputs that steer {@link formatMessage}'s formatter selection. */
export interface FormatMessageOptions {
	/** When present, the raw request is dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, appended to the message when available. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
	/** Provider id; `"github-copilot"` triggers the copilot message rewrite. */
	provider?: string;
}

/**
 * Format a provider error into a user-facing message, unifying the three
 * formatters: lightweight retry-after extraction, the raw-dump finalizer, and
 * the copilot rewrite.
 *
 * Selection is driven by inputs, not a mode flag: a `rawRequestDump` routes
 * through {@link finalizeErrorMessage} (retry-after + raw dump + captured body),
 * otherwise the lightweight {@link formatErrorMessageWithRetryAfter} is used.
 */
export async function formatMessage(error: unknown, opts: FormatMessageOptions = {}): Promise<string> {
	let message = opts.rawRequestDump
		? await finalizeErrorMessage(error, opts.rawRequestDump, opts.capturedErrorResponse)
		: formatErrorMessageWithRetryAfter(error);
	if (opts.provider === "github-copilot") {
		message = rewriteCopilotError(message, error, opts.provider);
	}
	return message;
}
