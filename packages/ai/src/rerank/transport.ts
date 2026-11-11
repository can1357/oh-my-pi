import { fetchWithRetry, type FetchWithRetryOptions } from "@oh-my-pi/pi-utils";
import { type ApiKey, NO_AUTH_SENTINEL, withAuth } from "../auth-retry";
import { mergeHeaders } from "../providers/anthropic-headers";

export interface RerankTransportOptions {
	apiKey: ApiKey;
	headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
	signal?: AbortSignal;
	fetch?: FetchWithRetryOptions["fetch"];
	maxAttempts?: number;
	defaultDelayMs?: FetchWithRetryOptions["defaultDelayMs"];
	onHttpError?: (response: Response) => Error | undefined | Promise<Error | undefined>;
}

/** Shared POST/auth/retry transport for rerank providers with different wire formats. */
export function postRerankRequest(url: string | URL, body: string, options: RerankTransportOptions): Promise<Response> {
	return withAuth(
		options.apiKey,
		async key => {
			const additionalHeaders = typeof options.headers === "function" ? await options.headers() : options.headers;
			const response = await fetchWithRetry(url, {
				method: "POST",
				headers: mergeHeaders(
					key === NO_AUTH_SENTINEL ? undefined : { Authorization: `Bearer ${key}` },
					additionalHeaders,
				),
				body,
				signal: options.signal,
				fetch: options.fetch,
				maxAttempts: options.maxAttempts ?? 1,
				defaultDelayMs: options.defaultDelayMs,
			});
			if (!response.ok) {
				const error = await options.onHttpError?.(response);
				if (error !== undefined) throw error;
			}
			return response;
		},
		{ signal: options.signal },
	);
}
