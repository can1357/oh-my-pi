import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteClinePassError,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { isOpencodeFreeTierGateMessage, LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "./flags";

function rewriteOllamaToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `Local Ollama model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

/**
 * OpenCode's free-tier gate denial reads like an auth failure but is
 * model-scoped client policy: the key is valid and paid SKUs keep serving.
 * Explain that instead of surfacing the raw 403. The rewritten text keeps the
 * `FreeTierError` marker so {@link isOpencodeFreeTierGateMessage} keeps
 * matching downstream decision points that see only the final message (#12306).
 */
function rewriteOpencodeFreeTierGateError(message: string): string {
	if (!isOpencodeFreeTierGateMessage(message)) return message;
	return "OpenCode rejected this request with 403 FreeTierError: its free tier can only be used from within OpenCode. Your API key is valid — paid models on the same key keep working. Pick a paid model with /model; if this model is expected to work in omp, the gateway's gate has likely changed and the regression should be reported.";
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
	if (opts.provider === "opencode-zen" || opts.provider === "opencode-go") {
		message = rewriteOpencodeFreeTierGateError(message);
	}
	if (opts.provider === "ollama") {
		message = rewriteOllamaToolCallJsonError(message);
	}
	return message;
}
