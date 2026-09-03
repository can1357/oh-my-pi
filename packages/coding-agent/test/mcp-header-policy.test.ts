import { afterEach, describe, expect, it } from "bun:test";
import { mergeMCPHeaders, setGeneratedHeader } from "@oh-my-pi/pi-coding-agent/mcp/transports/header-policy";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";

const REQUEST_TIMEOUT_MS = 1_000;

let servers: Bun.Server<undefined>[] = [];

function serve(
	fetchHandler: (req: Request, server: Bun.Server<undefined>) => Response | Promise<Response>,
): Bun.Server<undefined> {
	const server = Bun.serve({ port: 0, fetch: fetchHandler });
	servers.push(server);
	return server;
}

afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});

async function rpcResult(req: Request): Promise<Response> {
	const body: unknown = await req.json();
	const id = body && typeof body === "object" && "id" in body ? body.id : null;
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }), {
		headers: { "Content-Type": "application/json" },
	});
}

describe("mergeMCPHeaders", () => {
	it("gives generated headers case-insensitive precedence over configured ones", () => {
		const merged = mergeMCPHeaders({
			generated: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			configured: { "content-type": "text/plain", accept: "text/html", "X-Tenant": "t" },
		});
		expect(merged).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"X-Tenant": "t",
		});
	});

	it("setGeneratedHeader replaces case-variant entries", () => {
		const headers: Record<string, string> = { authorization: "Bearer configured", "X-A": "1" };
		setGeneratedHeader(headers, "Authorization", "Bearer generated");
		expect(headers).toEqual({ Authorization: "Bearer generated", "X-A": "1" });
	});
});

describe("MCP transport header policy", () => {
	it("keeps generated protocol headers when configured headers collide by casing", async () => {
		let received: Headers | null = null;
		const server = serve(async req => {
			received = req.headers;
			return rpcResult(req);
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headers: { "content-type": "text/plain", "x-tenant": "t" },
		});
		await transport.connect();

		await transport.request("tools/list");
		expect(received!.get("content-type")).toBe("application/json");
		expect(received!.get("x-tenant")).toBe("t");
	});

	it("follows same-origin redirects with configured headers when origin-locked", async () => {
		let received: Headers | null = null;
		const server = serve(async (req, self) => {
			const url = new URL(req.url);
			if (url.pathname === "/mcp") {
				return new Response(null, {
					status: 307,
					headers: { Location: `http://127.0.0.1:${self.port}/mcp2` },
				});
			}
			received = req.headers;
			return rpcResult(req);
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headers: { "X-Tenant": "t" },
			headerPolicy: "origin-locked",
		});
		await transport.connect();

		const result = await transport.request<{ ok: boolean }>("tools/list");
		expect(result.ok).toBe(true);
		// Same origin: configured headers stay attached (§7.2.1).
		expect(received!.get("x-tenant")).toBe("t");
	});

	it("strips configured headers on cross-origin redirects when origin-locked", async () => {
		let received: Headers | null = null;
		const target = serve(async req => {
			received = req.headers;
			return rpcResult(req);
		});
		const origin = serve(
			async () =>
				new Response(null, {
					status: 307,
					headers: { Location: `http://127.0.0.1:${target.port}/mcp` },
				}),
		);
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${origin.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headers: { "X-Tenant": "secret" },
			headerPolicy: "origin-locked",
		});
		await transport.connect();

		const result = await transport.request<{ ok: boolean }>("tools/list");
		expect(result.ok).toBe(true);
		// Different origin: configured headers must not be forwarded (§7.2.1)…
		expect(received!.get("x-tenant")).toBeNull();
		// …while client-generated protocol headers still are.
		expect(received!.get("content-type")).toBe("application/json");
	});

	it("refuses method-changing redirects of POST requests when origin-locked", async () => {
		const server = serve(
			async (_req, self) =>
				new Response(null, {
					status: 302,
					headers: { Location: `http://127.0.0.1:${self.port}/elsewhere` },
				}),
		);
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headerPolicy: "origin-locked",
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toThrow("refusing to follow");
	});
});
