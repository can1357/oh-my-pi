import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteClinePassError,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { LLAMA_CPP_TOOL_CALL_PARSE_PATTERN, status } from "./flags";
import { networkFailureMessage } from "./network-cause";

function rewriteOllamaToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `Local Ollama model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

/** Inputs that steer {@link formatMessage}'s formatter selection. */
export interface FormatMessageOptions {
	/** When present, the raw request is dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, appended to the message when available. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
	/** Provider id; gates provider-specific user-facing rewrites. */
	provider?: string;
	/** URL of the failed attempt, for the network-failure sentence's host. */
	requestUrl?: string;
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
	// A rejected socket has no HTTP status: name the host, phase and proxy
	// direction before the raw runtime text (or a 400-class request dump) can
	// become the user-facing message.
	const httpStatus = status(error) ?? opts.capturedErrorResponse?.status;
	if (httpStatus === undefined) {
		const networkMessage = networkFailureMessage(error, opts.requestUrl);
		if (networkMessage !== undefined) return networkMessage;
	}
	let message = opts.rawRequestDump
		? await finalizeErrorMessage(error, opts.rawRequestDump, opts.capturedErrorResponse)
		: formatErrorMessageWithRetryAfter(error);
	if (opts.provider === "github-copilot") {
		message = rewriteCopilotError(message, error, opts.provider);
	}
	if (opts.provider === "cline-pass") {
		message = rewriteClinePassError(message, opts.provider);
	}
	if (opts.provider === "ollama") {
		message = rewriteOllamaToolCallJsonError(message);
	}
	return message;
}
