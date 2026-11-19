import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

/** Wrap a fetch handler as a {@link FetchImpl}, normalizing sync `Response` returns. */
export function mockFetch(fn: FetchHandler): FetchImpl {
	return async (input, init) => fn(input, init);
}

/** Satisfies Bun's `typeof fetch` (includes `preconnect`). */
export function asGlobalFetch(fn: FetchHandler): typeof fetch {
	return Object.assign(async (input: string | URL | Request, init?: RequestInit) => fn(input, init), {
		preconnect: fetch.preconnect,
	});
}

/** `RequestInfo` alias for test fetch handlers (DOM lib name). */
export type FetchInput = string | URL | Request;
