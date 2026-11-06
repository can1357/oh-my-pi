import type { FetchImpl } from "../types";
import { getNativeFinishReasonError } from "./native-finish-reason";

/**
 * Responses can normalize upstream failures to completed without exposing the
 * native reason. Only a metadata-lag 404 with non-reasoning output usage triggers
 * inferred malformed-response recovery; usage does not confirm the native reason.
 * Other diagnostic failures leave the original empty-stop recovery unchanged.
 */
export async function readOpenRouterGenerationError(args: {
	baseUrl: string;
	headers: Record<string, string>;
	responseId: string;
	outputTokens?: number;
	reasoningTokens?: number;
	fetch?: FetchImpl;
	signal: AbortSignal;
}): Promise<string | undefined> {
	const timeout = AbortSignal.timeout(2_000);
	const signal = AbortSignal.any([args.signal, timeout]);
	try {
		const url = new URL(`${args.baseUrl.replace(/\/$/, "")}/generation`);
		url.searchParams.set("id", args.responseId);
		const response = await (args.fetch ?? fetch)(url.toString(), {
			method: "GET",
			headers: args.headers,
			signal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			return response.status === 404 ? fallbackDroppedOutputError(args) : undefined;
		}
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("data" in body)) return undefined;
		const data = body.data;
		if (!data || typeof data !== "object" || !("id" in data) || data.id !== args.responseId) return undefined;
		if (!("native_finish_reason" in data)) return undefined;
		const error = getNativeFinishReasonError(data.native_finish_reason);
		return error ? `${error}; response ID: ${args.responseId}` : undefined;
	} catch {
		// Unavailable diagnostics do not establish a native generation failure.
		// Cancellation is checked by the caller.
		return undefined;
	}
}

function fallbackDroppedOutputError(args: {
	responseId: string;
	outputTokens?: number;
	reasoningTokens?: number;
}): string | undefined {
	const nonReasoningOutputTokens = Math.max(0, (args.outputTokens ?? 0) - (args.reasoningTokens ?? 0));
	if (nonReasoningOutputTokens <= 0) return undefined;
	return `Provider returned error (inferred MALFORMED_RESPONSE: empty output with non-reasoning usage; generation metadata not ready); response ID: ${args.responseId}`;
}
