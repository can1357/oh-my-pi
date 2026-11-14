import { afterEach, describe, expect, it } from "bun:test";
import { setGeneratedHeader } from "@oh-my-pi/pi-coding-agent/mcp/transports/header-policy";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATSgAwIBAgIUDqCmhiK21hvtyURmE/76OrsM3uAwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwMjEwNTkxOVoXDTM2MTAzMDEw
NTkxOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEqycvffwX7Io1d6iPMUwKxQKMmFNOM0W6y+TCsNEuO98eWw/wo0k77nu2
bP2xZKMnRIb6wbLzV13uKg2ecnx8/6NkMGIwHQYDVR0OBBYEFDaRMfwu47VwcmQv
Svy3fCJ4P1ZhMB8GA1UdIwQYMBaAFDaRMfwu47VwcmQvSvy3fCJ4P1ZhMA8GA1Ud
EwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATAKBggqhkjOPQQDAgNIADBFAiBl
xMSDtuVept0Bnxzruqh7mtsMb4X6VWHHWWDYXuS2pQIhAK/itPm9sIZz6Uyhc6gR
mGfVkPweGy4+kmJWjWPweYxl
-----END CERTIFICATE-----`;
const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglg9cMDeqF3Fslium
RxInOHNKJEWlaNl7nE/8jR2bXVShRANCAASrJy99/BfsijV3qI8xTArFAoyYU04z
RbrL5MKw0S473x5bD/CjSTvue7Zs/bFkoydEhvrBsvNXXe4qDZ5yfHz/
-----END PRIVATE KEY-----`;

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

describe("setGeneratedHeader", () => {
	it("setGeneratedHeader replaces case-variant entries", () => {
		const headers: Record<string, string> = { authorization: "Bearer configured", "X-A": "1" };
		setGeneratedHeader(headers, "Authorization", "Bearer generated");
		expect(headers).toEqual({ Authorization: "Bearer generated", "X-A": "1" });
	});
});

describe("MCP transport header policy", () => {
	it("trusts a CA loaded after startup for HTTP requests and origin-locked redirects", async () => {
		const originalCa = Bun.env.NODE_EXTRA_CA_CERTS;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-ca-"));
		const caFile = path.join(dir, "ca.pem");
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: { cert: LOCALHOST_CERT, key: LOCALHOST_KEY },
			async fetch(req) {
				if (new URL(req.url).pathname === "/redirect") {
					return new Response(null, { status: 307, headers: { Location: "/mcp" } });
				}
				return rpcResult(req);
			},
		});
		try {
			delete Bun.env.NODE_EXTRA_CA_CERTS;
			const direct = new HttpTransport({
				type: "http",
				url: `https://127.0.0.1:${server.port}/mcp`,
				timeout: REQUEST_TIMEOUT_MS,
			});
			await direct.connect();
			try {
				await expect(direct.request("tools/list")).rejects.toThrow();
				await Bun.write(caFile, LOCALHOST_CERT);
				Bun.env.NODE_EXTRA_CA_CERTS = caFile;
				expect(await direct.request<{ ok: boolean }>("tools/list")).toEqual({ ok: true });
			} finally {
				await direct.close();
			}

			const locked = new HttpTransport({
				type: "http",
				url: `https://127.0.0.1:${server.port}/redirect`,
				timeout: REQUEST_TIMEOUT_MS,
				headerPolicy: "origin-locked",
			});
			await locked.connect();
			try {
				expect(await locked.request<{ ok: boolean }>("tools/list")).toEqual({ ok: true });
			} finally {
				await locked.close();
			}
		} finally {
			server.stop(true);
			if (originalCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
			else Bun.env.NODE_EXTRA_CA_CERTS = originalCa;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

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
