import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteClinePassError,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { isOpenCodeFreeTierGateMessage, LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "./flags";

function rewriteOllamaToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `Local Ollama model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

/** Matched on the provider's text, not the provider id, so custom providers fronting Zen get it too. */
function rewriteOpenCodeFreeTierError(message: string): string {
	if (!isOpenCodeFreeTierGateMessage(message)) return message;
	return `OpenCode Zen only serves its free models to the OpenCode app, so omp cannot use this one; your key still works for paid Zen models. Pick another model with /model, or run this one in OpenCode.\n${message}`;
}

/** Inputs that steer {@link formatMessage}'s formatter selection. */
export interface FormatMessageOptions {
	/** When present, the raw request is dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, appended to the message when available. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
	/** Provider id; gates provider-specific user-facing rewrites. */
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
	if (opts.provider === "cline-pass") {
		message = rewriteClinePassError(message, opts.provider);
	}
	if (opts.provider === "ollama") {
		message = rewriteOllamaToolCallJsonError(message);
	}
	message = rewriteOpenCodeFreeTierError(message);
	return message;
}
