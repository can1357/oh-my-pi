import type { FetchImpl } from "@oh-my-pi/pi-utils";

/** What a scripted fetch saw of one request. */
export interface FetchSeen {
	url: string;
	method: string;
	probeHeader: string | null;
	body: string;
}

/**
 * A `fetch` override standing in for a session's own (a proxy-aware or
 * instrumented fetch): `/fail` rejects like a network failure, `/hold` sends
 * one chunk and then fails the body with the abort reason once the request
 * signal aborts, anything else answers 201 with two body chunks.
 */
export function scriptedFetch(seen: FetchSeen[]): FetchImpl {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const request = new Request(url, init);
		seen.push({
			url,
			method: request.method,
			probeHeader: request.headers.get("x-probe"),
			body: await request.text(),
		});
		if (url.endsWith("/fail")) throw new TypeError("scripted network failure");
		const signal = init?.signal ?? undefined;
		const hold = url.endsWith("/hold");
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(encoder.encode("chunk-1;"));
				if (hold) {
					if (!signal) throw new Error("/hold needs an abort signal");
					const { promise, resolve } = Promise.withResolvers<void>();
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
					await promise;
					controller.error(signal.reason);
					return;
				}
				controller.enqueue(encoder.encode("chunk-2;"));
				controller.close();
			},
		});
		return new Response(body, { status: 201, statusText: "Created", headers: { "x-reply": "from-fetch" } });
	};
}
