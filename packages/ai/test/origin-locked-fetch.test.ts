import { afterEach, describe, expect, it } from "bun:test";
import { wrapFetchForOriginLockedHeaders } from "@oh-my-pi/pi-ai/utils/origin-locked-fetch";
import type { Server } from "bun";

interface Arrival {
	origin: string;
	path: string;
	method: string;
	partner: string | null;
	authorization: string | null;
	body: string;
}

const servers: Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

/** A real server, so redirects go through the runtime's own fetch rather than a model of it. */
function serve(arrivals: Arrival[], route: (path: string) => Response | undefined): Server<undefined> {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			arrivals.push({
				origin: url.origin,
				path: url.pathname,
				method: request.method,
				partner: request.headers.get("x-partner-id"),
				authorization: request.headers.get("authorization"),
				body: await request.text(),
			});
			return route(url.pathname) ?? new Response("ok");
		},
	});
	servers.push(server);
	return server;
}

function redirect(status: number, location: string): Response {
	return new Response(null, { status, headers: { location } });
}

describe("wrapFetchForOriginLockedHeaders", () => {
	it("keeps locked headers on the locked origin and drops them on a redirect to another origin", async () => {
		const arrivals: Arrival[] = [];
		const elsewhere = serve(arrivals, () => undefined);
		const locked = serve(arrivals, path =>
			path === "/start"
				? redirect(307, "/moved")
				: path === "/moved"
					? redirect(308, new URL("/landed", elsewhere.url).href)
					: undefined,
		);
		const lockedFetch = wrapFetchForOriginLockedHeaders(fetch, {
			origin: locked.url.origin,
			names: ["X-Partner-ID"],
		});

		const response = await lockedFetch(new URL("/start", locked.url), {
			method: "POST",
			body: "payload",
			headers: { "x-partner-id": "part_test", Authorization: "Bearer key" },
		});

		expect(await response.text()).toBe("ok");
		const hop = { method: "POST", body: "payload" };
		expect(arrivals).toEqual([
			{ ...hop, origin: locked.url.origin, path: "/start", partner: "part_test", authorization: "Bearer key" },
			{ ...hop, origin: locked.url.origin, path: "/moved", partner: "part_test", authorization: "Bearer key" },
			{ ...hop, origin: elsewhere.url.origin, path: "/landed", partner: null, authorization: null },
		]);
	});

	it("returns a redirect that would turn a POST into a GET instead of following it", async () => {
		// The platform would resend it as a body-less GET; the caller has to see
		// the redirect as an HTTP error instead.
		const arrivals: Arrival[] = [];
		const locked = serve(arrivals, path => (path === "/start" ? redirect(302, "/moved") : undefined));
		const lockedFetch = wrapFetchForOriginLockedHeaders(fetch, { origin: locked.url.origin, names: [] });

		const response = await lockedFetch(new URL("/start", locked.url), { method: "POST", body: "payload" });

		expect(response.status).toBe(302);
		expect(arrivals.map(arrival => arrival.path)).toEqual(["/start"]);
	});
});
