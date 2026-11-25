import { expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { HttpSession } from "@oh-my-pi/pi-coding-agent/web/http-session";

function serve(handler: (request: Request) => Response | Promise<Response>): Bun.Server<undefined> {
	return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
}

function redirect(location: string, status = 302, cookies: readonly string[] = []): Response {
	const headers = new Headers({ location });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status, headers });
}

/** Route logical hostnames and schemes to a local fixture, without changing the URL seen by HttpSession. */
function localFetch(server: Bun.Server<undefined>): FetchImpl {
	return (input, init) => {
		const logical = new URL(String(input));
		const local = new URL(server.url);
		local.pathname = logical.pathname;
		local.search = logical.search;
		return fetch(local, init);
	};
}

it("returns to the same URL with the bounce cookie rather than treating it as a loop", async () => {
	using server = serve(request =>
		request.headers.get("cookie") === "bounce=1" ? new Response("accepted") : redirect("/", 302, ["bounce=1"]),
	);
	const result = await new HttpSession().request({ url: server.url.href });
	expect(result.status).toBe(200);
	expect(result.body?.toString()).toBe("accepted");
});

it("sends every Set-Cookie value from a redirect on the next matching hop", async () => {
	using server = serve(request => {
		if (new URL(request.url).pathname === "/start") {
			return redirect("/done", 302, ["first=1; Path=/", "second=2; Path=/done"]);
		}
		return new Response(request.headers.get("cookie"));
	});
	const result = await new HttpSession().request({ url: new URL("/start", server.url).href });
	expect(result.url).toBe(new URL("/done", server.url).href);
	expect(result.body?.toString()).toBe("second=2; first=1");
});

it("limits cookies by request path, host, Domain, security and expiration", async () => {
	using server = serve(request => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/nested/seed" || pathname === "/nested/expire") {
			const headers = new Headers();
			for (const cookie of pathname === "/nested/seed"
				? [
						"host=1",
						"domain=2; Domain=.example.test; Path=/nested",
						"secure=3; Domain=example.test; Secure; Path=/",
						"foreign=4; Domain=other.test; Path=/",
						"deleted=5; Expires=Sat, 01 Jan 2000 00:00:00 GMT; Max-Age=60; Path=/",
					]
				: ["deleted=gone; Max-Age=0; Path=/"]) {
				headers.append("Set-Cookie", cookie);
			}
			return new Response(null, { headers });
		}
		return new Response(request.headers.get("cookie") ?? "no cookies");
	});
	const session = new HttpSession(localFetch(server));
	const cookieAt = async (url: string) => (await session.request({ url })).body?.toString();
	await session.request({ url: "https://example.test/nested/seed" });
	expect(await cookieAt("https://example.test/nested/echo")).toBe("host=1; domain=2; secure=3; deleted=5");
	await session.request({ url: "https://example.test/nested/expire" });
	expect(await cookieAt("https://sub.example.test/nested/echo")).toBe("domain=2; secure=3");
	expect(await cookieAt("http://sub.example.test/nested/echo")).toBe("domain=2");
	expect(await cookieAt("https://example.test/nested-other")).toBe("secure=3");
	expect(await cookieAt("https://other.test/")).toBe("no cookies");
});

it("returns a transport error without dispatching an eleventh redirect hop", async () => {
	let dispatched = 0;
	using server = serve(() => {
		dispatched++;
		return redirect("/");
	});
	const result = await new HttpSession().request({ url: server.url.href });
	expect(result.status).toBe(0);
	expect(result.error).toMatch(/too many.*redirect/i);
	expect(dispatched).toBe(11);
});

it("drops the body and its content type when a 303 rewrites POST to GET", async () => {
	using server = serve(async request => {
		if (new URL(request.url).pathname === "/") {
			if ((await request.text()) !== "token") return new Response("expected POST body", { status: 400 });
			return redirect("/done", 303);
		}
		return Response.json({
			method: request.method,
			type: request.headers.get("content-type"),
			body: await request.text(),
		});
	});
	const result = await new HttpSession().request({
		url: server.url.href,
		method: "POST",
		headers: [{ name: "Content-Type", value: "application/octet-stream" }],
		body: "token",
	});
	expect(result.status).toBe(200);
	expect(JSON.parse(result.body?.toString() ?? "null")).toEqual({ method: "GET", type: null, body: "" });
});

it("preserves a POST method and body on a same-origin 308", async () => {
	using server = serve(async request => {
		if (new URL(request.url).pathname === "/") return redirect("/finish", 308);
		return new Response(`${request.method}:${await request.text()}`);
	});
	const result = await new HttpSession().request({ url: server.url.href, method: "POST", body: "token" });
	expect(result.status).toBe(200);
	expect(result.body?.toString()).toBe("POST:token");
});

it("does not forward a POST body to another origin on a 307", async () => {
	let received = false;
	using outside = serve(() => {
		received = true;
		return new Response("leaked");
	});
	using server = serve(() => redirect(outside.url.href, 307));
	const result = await new HttpSession().request({ url: server.url.href, method: "POST", body: "secret" });
	expect(result.status).toBe(0);
	expect(result.error).toMatch(/cross-origin/i);
	expect(received).toBe(false);
});

it("does not dispatch an HTTPS-to-HTTP redirect", async () => {
	let dispatched = 0;
	using server = serve(() => {
		dispatched++;
		return redirect("http://example.test/next");
	});
	const result = await new HttpSession(localFetch(server)).request({ url: "https://example.test/start" });
	expect(result.status).toBe(0);
	expect(result.error).toMatch(/HTTPS to HTTP/i);
	expect(dispatched).toBe(1);
});

it("refuses credentials in both the initial URL and redirect target before dispatch", async () => {
	let dispatched = 0;
	using server = serve(request => {
		dispatched++;
		const next = new URL("/target", request.url);
		next.username = "user";
		next.password = "secret";
		return redirect(next.href);
	});
	const session = new HttpSession();
	const credentials = new URL(server.url);
	credentials.username = "user";
	credentials.password = "secret";
	for (const url of [credentials.href, server.url.href]) {
		const result = await session.request({ url });
		expect(result.status).toBe(0);
		expect(result.error).toMatch(/credentials in urls/i);
	}
	expect(dispatched).toBe(1);
});

it("retries a 429 with Retry-After once, then returns the next 429 intact", async () => {
	let attempts = 0;
	using server = serve(() => {
		return new Response(`rate limited ${++attempts}`, { status: 429, headers: { "Retry-After": "0" } });
	});
	const result = await new HttpSession().request({ url: server.url.href });
	expect(result.status).toBe(429);
	expect(result.body?.toString()).toBe("rate limited 2");
	expect(attempts).toBe(2);
});

it("aborts during a Retry-After wait without making the retry", async () => {
	let attempts = 0;
	using server = serve(() => {
		attempts++;
		return new Response(null, { status: 429, headers: { "Retry-After": "5" } });
	});
	const controller = new AbortController();
	const discarded = Promise.withResolvers<void>();
	const session = new HttpSession(async (input, init) => {
		const response = await fetch(input, init);
		return new Response(
			new ReadableStream({
				cancel() {
					discarded.resolve();
					return response.body?.cancel();
				},
			}),
			response,
		);
	});
	const reading = session.request({ url: server.url.href, signal: controller.signal });
	await discarded.promise;
	controller.abort(new Error("stop the wait"));
	const result = await reading;
	expect(result.status).toBe(0);
	expect(result.error).toContain("stop the wait");
	expect(attempts).toBe(1);
});

it("skips the body when the caller rejects the final MIME type, retaining response headers", async () => {
	using server = serve(request => {
		if (new URL(request.url).pathname === "/") return redirect("/movie");
		return new Response("movie bytes", { headers: { "Content-Type": "Video/MP4; x-test=1" } });
	});
	const result = await new HttpSession().request({
		url: server.url.href,
		skipBody: contentType => contentType === "video/mp4",
	});

	expect(result.url).toBe(new URL("/movie", server.url).href);
	expect(result.status).toBe(200);
	expect(result.body?.byteLength).toBe(0);
	expect(result.truncated).toBe(false);
	expect(result.headers).toContainEqual({ name: "content-type", value: "Video/MP4; x-test=1" });
});

it("caps the response at maxBytes and reports whether bytes were discarded", async () => {
	using server = serve(request => {
		const encoding = request.headers.get("accept-encoding");
		return new Response("0123456789", { headers: { "x-request-encoding": encoding ?? "missing" } });
	});
	const session = new HttpSession();
	const clipped = await session.request({ url: server.url.href, maxBytes: 4 });
	expect(clipped.status).toBe(200);
	expect(clipped.body?.toString()).toBe("0123");
	expect(clipped.truncated).toBe(true);
	expect(clipped.headers).toContainEqual({ name: "x-request-encoding", value: "identity" });

	const complete = await session.request({ url: server.url.href, maxBytes: 10 });
	expect(complete.body?.toString()).toBe("0123456789");
	expect(complete.truncated).toBe(false);
});
