import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { McpRemoteSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { setGeneratedHeader } from "@oh-my-pi/pi-coding-agent/mcp/host/header-policy";
import { HttpUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/http-upstream";
import { rejectionOf } from "../helpers/rejection";
import { httpSpec } from "./upstream-support";

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

const servers: Bun.Server<undefined>[] = [];
const upstreams: HttpUpstream[] = [];

afterEach(async () => {
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const server of servers.splice(0)) await server.stop(true);
});

function serve(
	fetchHandler: (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>,
): Bun.Server<undefined> {
	const server = Bun.serve({ port: 0, fetch: fetchHandler });
	servers.push(server);
	return server;
}

async function rpcResult(request: Request): Promise<Response> {
	const body: unknown = await request.json();
	const id = body && typeof body === "object" && "id" in body ? body.id : null;
	return Response.json({ jsonrpc: "2.0", id, result: { ok: true } });
}

async function connected(url: string, overrides: Partial<McpRemoteSpec> = {}): Promise<HttpUpstream> {
	const upstream = new HttpUpstream({ ...httpSpec(url), ...overrides }, "legacy");
	upstreams.push(upstream);
	await upstream.connect();
	return upstream;
}

describe("setGeneratedHeader", () => {
	it("replaces an entry whose name differs only in case, so one value is sent", () => {
		const headers: Record<string, string> = { authorization: "Bearer configured", "X-A": "1" };

		setGeneratedHeader(headers, "Authorization", "Bearer generated");

		expect(headers).toEqual({ Authorization: "Bearer generated", "X-A": "1" });
	});
});

describe("header policy of a remote MCP upstream", () => {
	it("trusts a CA loaded after startup, for direct requests and for origin-locked redirects", async () => {
		const originalCa = Bun.env.NODE_EXTRA_CA_CERTS;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-ca-"));
		const caFile = path.join(dir, "ca.pem");
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: { cert: LOCALHOST_CERT, key: LOCALHOST_KEY },
			async fetch(request) {
				if (new URL(request.url).pathname === "/redirect") {
					return new Response(null, { status: 307, headers: { Location: "/mcp" } });
				}
				return rpcResult(request);
			},
		});
		try {
			delete Bun.env.NODE_EXTRA_CA_CERTS;
			const direct = await connected(`https://127.0.0.1:${server.port}/mcp`);
			expect(await rejectionOf(direct.request("tools/list"))).toMatchObject({ transport: "http", stage: "send" });

			await Bun.write(caFile, LOCALHOST_CERT);
			Bun.env.NODE_EXTRA_CA_CERTS = caFile;
			expect(await direct.request<unknown>("tools/list")).toEqual({ ok: true });

			const locked = await connected(`https://127.0.0.1:${server.port}/redirect`, { headerPolicy: "origin-locked" });
			expect(await locked.request<unknown>("tools/list")).toEqual({ ok: true });
		} finally {
			await server.stop(true);
			if (originalCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
			else Bun.env.NODE_EXTRA_CA_CERTS = originalCa;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the protocol's own headers when configured ones collide with them by casing", async () => {
		const received = Promise.withResolvers<Headers>();
		const server = serve(async request => {
			received.resolve(request.headers);
			return rpcResult(request);
		});
		const upstream = await connected(`http://127.0.0.1:${server.port}/mcp`, {
			headers: { "content-type": "text/plain", "x-tenant": "t" },
		});

		await upstream.request("tools/list");

		const headers = await received.promise;
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-tenant")).toBe("t");
	});

	it("follows a same-origin redirect with the configured headers when origin-locked", async () => {
		const received = Promise.withResolvers<Headers>();
		const server = serve(async (request, self) => {
			if (new URL(request.url).pathname === "/mcp") {
				return new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${self.port}/mcp2` } });
			}
			received.resolve(request.headers);
			return rpcResult(request);
		});
		const upstream = await connected(`http://127.0.0.1:${server.port}/mcp`, {
			headers: { "X-Tenant": "t" },
			headerPolicy: "origin-locked",
		});

		expect(await upstream.request<unknown>("tools/list")).toEqual({ ok: true });
		expect((await received.promise).get("x-tenant")).toBe("t");
	});

	it("drops the configured headers on a cross-origin redirect when origin-locked, keeping the protocol's own", async () => {
		const received = Promise.withResolvers<Headers>();
		const target = serve(async request => {
			received.resolve(request.headers);
			return rpcResult(request);
		});
		const origin = serve(
			async () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/mcp` } }),
		);
		const upstream = await connected(`http://127.0.0.1:${origin.port}/mcp`, {
			headers: { "X-Tenant": "secret" },
			headerPolicy: "origin-locked",
		});

		expect(await upstream.request<unknown>("tools/list")).toEqual({ ok: true });
		const headers = await received.promise;
		expect(headers.get("x-tenant")).toBeNull();
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("refuses a redirect that would turn a POST into a GET when origin-locked", async () => {
		const server = serve(
			async (_request, self) =>
				new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${self.port}/elsewhere` } }),
		);
		const upstream = await connected(`http://127.0.0.1:${server.port}/mcp`, { headerPolicy: "origin-locked" });

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({
			message: "HTTP 302: server redirected a POST request; refusing to follow",
		});
	});
});
