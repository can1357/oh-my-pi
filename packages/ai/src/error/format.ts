import {
	type CapturedHttpErrorResponse,
	finalizeErrorDisplayMessage,
	type RawHttpRequestDump,
	rewriteClinePassError,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "./flags";

function rewriteOllamaToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `Local Ollama model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

/** Inputs that steer {@link formatDisplayMessage}. */
export interface FormatDisplayMessageOptions {
	/** When present, the raw request is dumped and its path named for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, folded into the message when available. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
	/** Provider id; gates provider-specific user-facing rewrites. */
	provider?: string;
}

/**
 * Format a provider error the way omp shows it: the provider's text with the
 * response's retry hint, the rejected request's dump path and any
 * provider-specific rewrite. Display only: the dump path is local text, so
 * no decision may read the result. Providers store it as `errorDisplayMessage`.
 */
export async function formatDisplayMessage(error: unknown, opts: FormatDisplayMessageOptions = {}): Promise<string> {
	let message = await finalizeErrorDisplayMessage(error, opts.rawRequestDump, opts.capturedErrorResponse);
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
