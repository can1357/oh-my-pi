import { DEFAULT_TIMEOUT_MS } from "./config";

/** `fetch` that aborts once `timeoutMs` elapses. */
export function request(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
